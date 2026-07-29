import WebSocket from "ws";
import { OpCode, } from "./types.js";
import { debug, error as logError } from "./logger.js";
const GATEWAY_API = "https://api.sgroup.qq.com/gateway";
// C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE + FRIEND_ADD + GROUP_ADD_ROBOT
const INTENTS = 1 << 25;
/**
 * QQ Bot WebSocket 客户端。
 * 管理连接、鉴权、心跳、断线重连（Resume）。
 */
export function createWsClient(auth) {
    let _ws = null;
    let _sessionId = null;
    let _seq = 0;
    let _heartbeatInterval = 45_000;
    let _heartbeatTimer = null;
    let _reconnectTimer = null;
    let _intentionalClose = false;
    let _connectedAt = null;
    let _lastHeartbeatAck = null;
    let _reconnectCount = 0;
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
            // 断线重连：Resume
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
            // 首次连接：Identify
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
    function handlePayload(payload) {
        if (payload.s)
            _seq = payload.s;
        switch (payload.op) {
            case OpCode.Hello: {
                const hello = payload.d;
                _heartbeatInterval = hello.heartbeat_interval;
                startHeartbeat();
                onHello().catch((err) => logError(`鉴权失败: ${err}`));
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
                _sessionId = null;
                scheduleReconnect(1000);
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
                break;
            }
            case "RESUMED":
                debug("[QQ Bot WS] 断线重连成功");
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
        return {
            id: raw.id,
            content: raw.content,
            session,
            timestamp: raw.timestamp,
            eventId: raw.id,
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
    function scheduleReconnect(delayMs) {
        if (_intentionalClose)
            return;
        stopHeartbeat();
        if (_reconnectTimer)
            clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => {
            connect().catch((err) => {
                logError(`重连失败，5 秒后重试: ${err}`);
                scheduleReconnect(5000);
            });
        }, delayMs);
    }
    async function connect() {
        _intentionalClose = false;
        const url = await getGatewayUrl();
        return new Promise((resolve, reject) => {
            try {
                debug(`[QQ Bot WS] 连接: ${url}`);
                _ws = new WebSocket(url);
                const timeout = setTimeout(() => {
                    reject(new Error("WebSocket 连接超时"));
                }, 15_000);
                _ws.on("open", () => {
                    debug("[QQ Bot WS] TCP 连接已建立");
                });
                _ws.on("message", (data) => {
                    try {
                        const payload = JSON.parse(data.toString());
                        // 首次 Hello 时 resolve 连接 Promise
                        if (payload.op === OpCode.Hello) {
                            clearTimeout(timeout);
                            resolve(undefined);
                        }
                        handlePayload(payload);
                    }
                    catch (err) {
                        logError(`消息解析失败: ${err}`);
                    }
                });
                _ws.on("close", (code, reason) => {
                    _reconnectCount++;
                    debug(`[QQ Bot WS] 连接关闭 (${code}): ${reason?.toString() ?? "unknown"}`);
                    stopHeartbeat();
                    _ws = null;
                    if (!_intentionalClose) {
                        scheduleReconnect(1000);
                    }
                });
                _ws.on("error", (err) => {
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
    }
    return { connect, disconnect, onMessage, onEvent, getSessionId, getDiagnostics };
}
