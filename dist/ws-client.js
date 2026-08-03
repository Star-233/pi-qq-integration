import WebSocket from "ws";
import { OpCode, } from "./types.js";
import { debug, error as logError, warn } from "./logger.js";
import { ENDPOINTS, DEFAULTS } from "./constants.js";
const GATEWAY_API = ENDPOINTS.GATEWAY;
const INTENTS = DEFAULTS.INTENTS;
/** 指数退避上限 */
const MAX_RECONNECT_DELAY_MS = 60_000;
/**
 * QQ Bot WebSocket 客户端。
 * 管理连接、鉴权、心跳、断线重连（Resume）。
 */
export function createWsClient(auth, options) {
    let _ws = null;
    let _sessionId = null;
    let _seq = 0;
    let _heartbeatInterval = DEFAULTS.WS_HEARTBEAT_MS;
    let _heartbeatTimer = null;
    let _reconnectTimer = null;
    let _intentionalClose = false;
    let _connectedAt = null;
    let _lastHeartbeatAck = null;
    let _reconnectCount = 0;
    /** 当前重连延迟（指数退避） */
    let _currentReconnectDelay = DEFAULTS.WS_RECONNECT_DELAY_MS;
    const _messageHandlers = [];
    const _eventHandlers = [];
    function onMessage(handler) {
        _messageHandlers.push(handler);
    }
    function onEvent(handler) {
        _eventHandlers.push(handler);
    }
    function getSessionId() {
        return _sessionId;
    }
    function getDiagnostics() {
        const state = _ws === null
            ? "disconnected"
            : _ws.readyState === WebSocket.OPEN
                ? "connected"
                : _ws.readyState === WebSocket.CONNECTING
                    ? "connecting"
                    : "closing";
        return {
            connected: _ws?.readyState === WebSocket.OPEN,
            state,
            sessionId: _sessionId,
            sequenceNumber: _seq,
            heartbeatIntervalMs: _heartbeatInterval,
            lastHeartbeatAck: _lastHeartbeatAck,
            reconnectCount: _reconnectCount,
            uptimeMs: _connectedAt ? Date.now() - _connectedAt : null,
        };
    }
    async function getGatewayUrl() {
        const token = await auth.getToken();
        const resp = await fetch(GATEWAY_API, {
            headers: { Authorization: `QQBot ${token}` },
        });
        if (!resp.ok) {
            throw new Error(`获取 Gateway 地址失败: ${resp.status}`);
        }
        const data = (await resp.json());
        return data.url;
    }
    function sendPayload(payload) {
        if (_ws?.readyState === WebSocket.OPEN) {
            _ws.send(JSON.stringify(payload));
        }
    }
    async function onHello() {
        const token = await auth.getToken();
        if (_sessionId) {
            sendPayload({
                op: OpCode.Resume,
                d: {
                    token: `QQBot ${token}`,
                    session_id: _sessionId,
                    seq: _seq,
                },
            });
        }
        else {
            sendPayload({
                op: OpCode.Identify,
                d: {
                    token: `QQBot ${token}`,
                    intents: INTENTS,
                    shard: [0, 1],
                },
            });
        }
    }
    let _connectControl = null;
    function resolveConnect() {
        if (_connectControl) {
            clearTimeout(_connectControl.timeout);
            _connectControl.resolve();
            _connectControl = null;
            _currentReconnectDelay = DEFAULTS.WS_RECONNECT_DELAY_MS; // 重置退避
            _connectedAt = Date.now();
        }
    }
    function rejectConnect(err) {
        if (_connectControl) {
            clearTimeout(_connectControl.timeout);
            _connectControl.reject(err);
            _connectControl = null;
        }
    }
    function handlePayload(payload) {
        if (payload.s)
            _seq = payload.s;
        switch (payload.op) {
            case OpCode.Hello: {
                const hello = payload.d;
                _heartbeatInterval = hello.heartbeat_interval;
                startHeartbeat();
                onHello().catch((err) => {
                    logError(`鉴权请求发送失败: ${err}`);
                    rejectConnect(err);
                });
                break;
            }
            case OpCode.Dispatch: {
                handleDispatch(payload);
                break;
            }
            case OpCode.HeartbeatACK:
                break;
            case OpCode.Reconnect:
                scheduleReconnect(0);
                break;
            case OpCode.InvalidSession:
                warn("[QQ Bot WS] InvalidSession — 鉴权被拒绝");
                _sessionId = null;
                options?.onAuthFailed?.();
                rejectConnect(new Error("QQ Bot 鉴权失败 (InvalidSession)"));
                break;
        }
    }
    function handleDispatch(payload) {
        const t = payload.t;
        switch (t) {
            case "READY": {
                const ready = payload.d;
                _sessionId = ready.session_id;
                debug(`[QQ Bot WS] Ready - session_id: ${_sessionId}`);
                resolveConnect(); // ← 鉴权真正成功，resolve connect()
                break;
            }
            case "RESUMED":
                debug("[QQ Bot WS] 断线重连成功");
                resolveConnect(); // ← Resume 成功
                break;
            case "C2C_MESSAGE_CREATE":
            case "GROUP_AT_MESSAGE_CREATE": {
                const msg = payload.d;
                const type = t === "C2C_MESSAGE_CREATE" ? "c2c" : "group";
                const qqMsg = toQQMessage(msg, type);
                _messageHandlers.forEach((h) => h(qqMsg));
                break;
            }
            case "FRIEND_ADD":
            case "GROUP_ADD_ROBOT":
                _eventHandlers.forEach((h) => h(t, payload.d));
                break;
        }
    }
    function toQQMessage(raw, type) {
        const session = {
            type,
            id: type === "c2c"
                ? raw.author.user_openid ?? raw.author.id ?? ""
                : raw.group_openid ?? "",
            name: raw.author.username ?? (type === "c2c" ? "好友" : "群聊"),
            userId: raw.author.user_openid ?? raw.author.member_openid,
            msgId: raw.id,
        };
        // 引用消息（message_type=103）：解析被引用消息索引与内容，供多实例定向路由
        let refMsgIdx;
        const ext = raw.message_scene?.ext ?? [];
        for (const kv of ext) {
            const eq = kv.indexOf("=");
            if (eq > 0 && kv.slice(0, eq) === "ref_msg_idx") {
                refMsgIdx = kv.slice(eq + 1);
                break;
            }
        }
        return {
            id: raw.id,
            content: raw.content,
            session,
            timestamp: raw.timestamp,
            eventId: raw.id,
            messageType: raw.message_type,
            refMsgIdx,
            refMsgContent: raw.msg_elements?.[0]?.content,
        };
    }
    function startHeartbeat() {
        stopHeartbeat();
        _heartbeatTimer = setInterval(() => {
            sendPayload({ op: OpCode.Heartbeat, d: _seq });
        }, _heartbeatInterval);
    }
    function stopHeartbeat() {
        if (_heartbeatTimer) {
            clearInterval(_heartbeatTimer);
            _heartbeatTimer = null;
        }
    }
    /** 指数退避重连：delay → delay*2 → delay*4 → ... → MAX_RECONNECT_DELAY_MS */
    function nextReconnectDelay() {
        const delay = _currentReconnectDelay;
        _currentReconnectDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        return delay;
    }
    function scheduleReconnect(delayMs) {
        if (_intentionalClose)
            return;
        stopHeartbeat();
        if (_reconnectTimer)
            clearTimeout(_reconnectTimer);
        const actualDelay = delayMs > 0 ? delayMs : nextReconnectDelay();
        debug(`[QQ Bot WS] 将在 ${actualDelay}ms 后重连`);
        _reconnectTimer = setTimeout(() => {
            connect().catch((err) => {
                logError(`重连失败: ${err}`);
                scheduleReconnect(0); // 使用指数退避
            });
        }, actualDelay);
    }
    async function connect() {
        _intentionalClose = false;
        const url = await getGatewayUrl();
        return new Promise((resolve, reject) => {
            try {
                debug(`[QQ Bot WS] 连接: ${url}`);
                const ws = new WebSocket(url);
                _ws = ws;
                const timeout = setTimeout(() => {
                    warn("[QQ Bot WS] 连接超时，终止 WebSocket");
                    ws.terminate(); // 强制关闭，防止半连接状态
                    if (_connectControl) {
                        _connectControl = null;
                        reject(new Error("WebSocket 连接超时"));
                    }
                }, DEFAULTS.WS_CONNECT_TIMEOUT_MS);
                _connectControl = { resolve, reject, timeout };
                ws.on("open", () => {
                    debug("[QQ Bot WS] TCP 连接已建立");
                });
                ws.on("message", (data) => {
                    try {
                        const payload = JSON.parse(data.toString());
                        handlePayload(payload);
                    }
                    catch (err) {
                        logError(`消息解析失败: ${err}`);
                    }
                });
                ws.on("close", (code, reason) => {
                    _reconnectCount++;
                    debug(`[QQ Bot WS] 连接关闭 (${code}): ${reason?.toString() ?? "unknown"}`);
                    stopHeartbeat();
                    // 守卫：只在当前 ws 实例匹配时才清空 _ws，防止错清空新连接
                    if (_ws === ws) {
                        _ws = null;
                    }
                    // 连接在 READY 之前被关闭 → reject connect()
                    rejectConnect(new Error(`WebSocket 在鉴权完成前关闭 (${code})`));
                    if (!_intentionalClose) {
                        scheduleReconnect(0);
                    }
                });
                ws.on("error", (err) => {
                    logError(`连接错误: ${err.message}`);
                });
            }
            catch (err) {
                reject(err);
            }
        });
    }
    function disconnect() {
        _intentionalClose = true;
        stopHeartbeat();
        if (_reconnectTimer) {
            clearTimeout(_reconnectTimer);
            _reconnectTimer = null;
        }
        if (_ws) {
            _ws.close(1000, "Intentional close");
            _ws = null;
        }
        _connectControl = null;
        _currentReconnectDelay = DEFAULTS.WS_RECONNECT_DELAY_MS;
    }
    return { connect, disconnect, onMessage, onEvent, getSessionId, getDiagnostics };
}
