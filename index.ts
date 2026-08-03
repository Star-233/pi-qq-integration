import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageEndEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, loadMultiInstanceConfig } from "./config.js";
import { loadSettings, saveSettings } from "./config.js";
import { createLockManager } from "./lock.js";
import { createIpcServer, createIpcClient } from "./ipc.js";
import {
	upsertInstance,
	removeInstance,
	setClaim,
	findClaimer,
	setLeader,
	clearLeader,
	getLeaderSock,
	pruneDead,
	touchInstance,
	readRegistry,
} from "./registry.js";
import { createAuthManager, type AuthManager } from "./auth.js";
import { createWsClient, type WsClient } from "./ws-client.js";
import { createApiClient, type ApiClient } from "./api-client.js";
import { createSessionManager, type SessionManager } from "./session-manager.js";
import { createCommandHandler } from "./command-handler.js";
import type {
	InstanceEntry,
	QQMessage,
	QBSession,
	QBSessionType,
	QqSettings,
	SendMessageResponse,
} from "./types.js";
import {
	error as logError,
	info,
	warn,
	debug,
	readRecentLines,
	getLogPath,
	clearLog,
} from "./logger.js";
import { createRequire } from "node:module";

import { PATHS, DEFAULTS, sessionTag } from "./constants.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

const LOCK_PATH = PATHS.LOCK;
const HEARTBEAT_INTERVAL_MS = DEFAULTS.HEARTBEAT_INTERVAL_MS;
const EXTENSION_VERSION = packageJson.version;

function stateLabel(state: string): string {
	switch (state) {
		case "connected":
			return "已连接";
		case "connecting":
			return "连接中";
		case "disconnected":
			return "已断开";
		case "closing":
			return "关闭中";
		default:
			return state;
	}
}

function formatDuration(ms: number): string {
	const sec = Math.floor(ms / 1000);
	const min = Math.floor(sec / 60);
	const hr = Math.floor(min / 60);
	if (hr > 0) return `${hr}时${min % 60}分${sec % 60}秒`;
	if (min > 0) return `${min}分${sec % 60}秒`;
	return `${sec}秒`;
}

function formatToolInput(input: unknown): string {
	return formatValue(input, 0);
}

function formatValue(value: unknown, depth = 0): string {
	const indent = "  ".repeat(depth);

	if (value === null || value === undefined) {
		return "`(空)`";
	}

	if (typeof value === "string") {
		return `\`${escapeBackticks(value)}\``;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return `\`${String(value)}\``;
	}

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "`(空数组)`";
		}
		return value
			.map((item, index) => {
				const formatted = formatValue(item, depth + 1);
				if (typeof item === "object" && item !== null) {
					return `${indent}- 第 ${index + 1} 项:\n${formatted}`;
				}
				return `${indent}- ${formatted}`;
			})
			.join("\n");
	}

	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			return "`(空对象)`";
		}
		return entries
			.map(([key, nestedValue]) => {
				if (
					nestedValue !== null &&
					nestedValue !== undefined &&
					(typeof nestedValue === "object" || Array.isArray(nestedValue))
				) {
					const formatted = formatValue(nestedValue, depth + 1);
					return `${indent}- \`${key}\`:\n${formatted}`;
				}
				return `${indent}- \`${key}\`: ${formatValue(nestedValue, 0)}`;
			})
			.join("\n");
	}

	return `\`${escapeBackticks(String(value))}\``;
}

function escapeBackticks(text: string): string {
	return text.replace(/`/g, "\\`");
}

function isTextBlock(p: unknown): p is { type: "text"; text: string } {
	return (
		typeof p === "object" &&
		p !== null &&
		(p as { type?: string }).type === "text" &&
		typeof (p as { text?: unknown }).text === "string"
	);
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(isTextBlock)
			.map((p) => p.text)
			.join("\n");
	}
	return "";
}

function buildMsgSeqMap(settings: QqSettings, activeSession?: QBSession | null): Map<string, number> {
	const map = new Map<string, number>();
	if (settings.defaultSession?.msgId && settings.defaultSession.lastMsgSeq) {
		map.set(settings.defaultSession.msgId, settings.defaultSession.lastMsgSeq);
	}
	if (activeSession?.msgId && activeSession.lastMsgSeq) {
		map.set(activeSession.msgId, activeSession.lastMsgSeq);
	}
	return map;
}

export default function (pi: ExtensionAPI) {
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig();
	} catch (err) {
		logError(`配置加载失败: ${(err as Error).message}`);
		return;
	}

	info(`pi-qq-integration 扩展加载: v${EXTENSION_VERSION}`);

	const lock = createLockManager(LOCK_PATH);
	let _ws: WsClient | null = null;
	let _auth: AuthManager | null = null;
	let _api: ApiClient | null = null;
	let _sm: SessionManager | null = null;
	let _cmdHandler: ReturnType<typeof createCommandHandler> | null = null;

	/** 转发设置 */
	let _settings: QqSettings = loadSettings();

	/** 最近一个发消息来的 QQ 会话（用于转发桌面消息和工具调用） */
	let _lastActiveQqSession: QBSession | null = null;

	/** 缓存最后一条 assistant 消息内容（供 agent_settled 使用，避免访问 stale ctx） */
	let _lastAssistantContent: unknown = null;

	// ── 多实例状态 ──
	const _multi = loadMultiInstanceConfig();
	let _role: "leader" | "follower" | null = null;
	const _instanceId = _multi.instanceId;
	/** 当前活跃 pi session 名（仅作为用户参考展示，不参与区分/路由；区分实例统一用 _instanceId） */
	let _sessionRef: string = "";
	/** leader 持有：发送消息索引(ref_idx) → 实例 id 映射，用于引用消息定向路由 */
	const _refIdxMap = new Map<string, { instanceId: string; ts: number }>();
	const _roleConfig = _multi.role;
	let _ipcServer: ReturnType<typeof createIpcServer> | null = null;
	let _ipcClient: ReturnType<typeof createIpcClient> | null = null;
	let _registryTimer: ReturnType<typeof setInterval> | null = null;
	let _followerStop = false;
	let _followerRetryTimer: ReturnType<typeof setTimeout> | null = null;
	/** follower 重连延迟（指数退避） */
	let _followerRetryDelay: number = DEFAULTS.FOLLOWER_RETRY_MS;
	/** 已通知过"与 leader 断开"（避免 error+close 双触发及重连循环刷屏，连接恢复时重置） */
	let _leaderDisconnectNotified = false;

	// ── 连接/断开 ──

		// ── 连接/断开（多实例：leader 持 QQ 连接，follower 经 IPC 委派）──

	// Windows 上 node:net 的 IPC 走命名管道，路径必须形如 \\.\pipe\... 或 \\?\pipe\...
	// （见 https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections）。
	// JavaScript 字符串需额外反斜杠转义：源码 `\\.\pipe\...` 运行时才得到 `\\.\pipe\...`。
	const LEADER_SOCK_PATH =
		process.platform === "win32"
			? `\\.\pipe\pi-qq-${process.pid}`
			: `${PATHS.INSTANCE_SOCK_DIR}/${process.pid}.sock`;

	async function connect(ctx: ExtensionContext): Promise<void> {
		if (_role) {
			ctx.ui.notify("QQ Bot: 已经连接了", "info");
			return;
		}
		const role = _roleConfig;
		if (role === "follower") {
			await becomeFollower(ctx);
			return;
		}
		const isOwner = await lock.acquire();
		if (isOwner) {
			await becomeLeader(ctx);
		} else if (role === "leader") {
			ctx.ui.notify("QQ Bot: 强制 leader 但锁被占用，转为 follower", "warning");
			await becomeFollower(ctx);
		} else {
			await becomeFollower(ctx);
		}
	}

	function selfEntry(role: "leader" | "follower"): InstanceEntry {
		return {
			id: _instanceId,
			pid: process.pid,
			role,
			name: _sessionRef,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
			claimedSessions: [],
		};
	}

	// ── pi session 名参考（仅展示用，不参与区分/路由）──

	/** 从 ctx 读取当前 pi session 名并刷新参考名（清洗后存入 registry.name） */
	function updateSessionRef(ctx?: ExtensionContext): void {
		let name: string | undefined;
		try {
			name = ctx?.sessionManager?.getSessionName?.()?.trim() || undefined;
		} catch {
			// 忽略
		}
		const next = sanitizeDisplayName(name);
		if (next !== _sessionRef) {
			_sessionRef = next;
			if (next) info(`实例 session 参考名更新: ${_sessionRef}`);
			publishSessionRef();
		}
	}

	/** 把当前 session 参考名上报到 registry（leader 直接写，follower 经 IPC 给 leader） */
	function publishSessionRef(): void {
		if (_role === "leader") {
			upsertInstance(selfEntry("leader"));
		} else if (_role === "follower" && _ipcClient) {
			_ipcClient.send({ type: "instance_update", name: _sessionRef });
		}
	}

	/** 出站消息统一署名前缀：实例唯一标识（instanceId），让 QQ 用户知道消息来自哪个实例 */
	function decorate(text: string): string {
		return `【${_instanceId}】${text}`;
	}

	/** 从引用消息内容中提取实例署名（【xxx】前缀），用于兜底路由 */
	function extractBracketName(content: string): string | null {
		const m = content.match(/^【([^】]+)】/);
		return m ? m[1] : null;
	}

	// ── 引用消息定向路由（leader 持有 refIdxMap）──

	const REF_IDX_TTL_MS = 60 * 60 * 1000; // 与被动消息有效期一致

	/** 发送成功后记录 ref_idx → 实例，供用户引用该消息时定向路由 */
	function trackSentRef(resp: SendMessageResponse | undefined, instanceId: string): void {
		const refIdx = resp?.ext_info?.ref_idx;
		if (refIdx) {
			_refIdxMap.set(refIdx, { instanceId, ts: Date.now() });
			if (_refIdxMap.size > 1000) pruneRefIdxMap(true);
		}
	}

	function pruneRefIdxMap(hard = false): void {
		const now = Date.now();
		for (const [k, v] of _refIdxMap) {
			if (now - v.ts > REF_IDX_TTL_MS) _refIdxMap.delete(k);
		}
		if (hard && _refIdxMap.size > 1000) {
			// 仍超限：驱逐最旧条目（硬上限防内存膨胀）
			const sorted = [..._refIdxMap.entries()].sort((a, b) => a[1].ts - b[1].ts);
			const excess = sorted.length - 1000;
			for (let i = 0; i < excess; i++) _refIdxMap.delete(sorted[i][0]);
		}
	}

	/** 解析引用消息应路由到的实例 id：ref_idx 精确映射优先，署名（instanceId）匹配兜底 */
	function resolveRouteInstance(qqMsg: QQMessage): string | null {
		if (qqMsg.refMsgIdx) {
			const hit = _refIdxMap.get(qqMsg.refMsgIdx);
			if (hit) {
				if (Date.now() - hit.ts <= REF_IDX_TTL_MS) return hit.instanceId;
				_refIdxMap.delete(qqMsg.refMsgIdx);
			}
		}
		// 署名兜底：被引用消息确为机器人所发（字段存在时），且恰好一个实例 id 匹配才路由
		if (qqMsg.refMsgContent) {
			if (qqMsg.refMsgFromBot === false) return null;
			const signed = extractBracketName(qqMsg.refMsgContent);
			if (signed) {
				const matches = Object.values(readRegistry().instances).filter((i) => i.id === signed);
				return matches.length === 1 ? matches[0].id : null;
			}
		}
		return null;
	}

	// ── 多实例定向辅助（#to / #instances）──

	/** 解析 #to 目标：instanceId 精确匹配优先，pi session 名（参考）唯一匹配兜底 */
	function resolveInstanceByName(target: string): InstanceEntry | null {
		const reg = readRegistry();
		const byId = reg.instances[target];
		if (byId) return byId;
		const matches = Object.values(reg.instances).filter((i) => i.name === target);
		return matches.length === 1 ? matches[0] : null;
	}

	/** 把会话认领切换到目标实例（leader 直接改 registry，follower 经 IPC 请求） */
	function rerouteSession(targetId: string, session: QBSession): boolean {
		const key = `${session.type}:${session.id}`;
		if (_role === "leader") {
			const reg = readRegistry();
			if (reg.instances[targetId] && (targetId === _instanceId || _ipcServer?.has(targetId))) {
				setClaim(targetId, key);
				return true;
			}
			return false;
		}
		if (_role === "follower" && _ipcClient) {
			if (!_ipcClient.isConnected()) return false;
			_ipcClient.send({ type: "reroute", sessionKey: key, targetId });
			return true;
		}
		return false;
	}

	/** 把内容注入目标实例的会话（#to <实例> <内容>；leader 直接路由，follower 经 IPC） */
	function injectContent(targetId: string, session: QBSession, content: string): void {
		if (_role === "leader") {
			if (targetId === _instanceId) {
				handleInboundQqMessage({ session, content });
			} else if (_ipcServer?.has(targetId)) {
				_ipcServer.sendTo(targetId, {
					type: "inbound",
					session,
					content,
					fromTag: sessionTag(session.type),
				});
			}
			return;
		}
		if (_role === "follower" && _ipcClient) {
			if (!_ipcClient.isConnected()) return;
			_ipcClient.send({ type: "inject", session, content });
		}
	}

	async function becomeLeader(ctx: ExtensionContext): Promise<void> {
		_role = "leader";
		lock.startHeartbeat(HEARTBEAT_INTERVAL_MS);
		ctx.ui.notify("QQ Bot: 正在连接（leader）...", "info");
		try {
			_auth = createAuthManager(config.appId, config.appSecret);
			_auth.onFatalError((err) => {
				logError(`Auth 致命错误: ${err.message}`);
				ctx.ui.notify(`QQ Bot: Token 刷新连续失败，连接已不可用 ❌`, "error");
				teardown();
			});
			await _auth.getToken();
			_auth.startRefresh();

			_api = createApiClient(_auth, {
				initialMsgSeqMap: buildMsgSeqMap(_settings, _lastActiveQqSession),
				onSeqUpdate: (msgId, seq) => {
					let changed = false;
					if (_settings.defaultSession?.msgId === msgId) {
						_settings.defaultSession.lastMsgSeq = seq;
						changed = true;
					}
					if (_lastActiveQqSession?.msgId === msgId) {
						_lastActiveQqSession.lastMsgSeq = seq;
					}
					if (changed) {
						saveSettings(_settings);
					}
				},
			});
			_sm = createSessionManager();

			// 命令回复同样带实例署名（leader 直接发，包装 api 统一加前缀 + 记录 ref_idx）
			const leaderCmdApi: ApiClient = {
				sendMarkdown: (s, md, r) =>
					(_api
						? _api.sendMarkdown(s, decorate(md), r).then((resp) => {
							trackSentRef(resp, _instanceId);
							return resp;
						})
						: Promise.resolve({} as SendMessageResponse)),
				sendText: (s, t, r) =>
					(_api
						? _api.sendText(s, decorate(t), r).then((resp) => {
							trackSentRef(resp, _instanceId);
							return resp;
						})
						: Promise.resolve({} as SendMessageResponse)),
				sendMessage: (s, t, o) =>
					(_api
						? _api.sendMessage(s, decorate(t), o).then((resp) => {
							trackSentRef(resp, _instanceId);
							return resp;
						})
						: Promise.resolve({} as SendMessageResponse)),
			};
			_cmdHandler = createCommandHandler(leaderCmdApi, _sm, {
				sendUserMessage: (text: string) => pi.sendUserMessage(text),
				switchSession: () => {},
				newSession: () => {},
				clearSession: () => {},
				getSettings: () => _settings,
				updateSettings: (update: Partial<QqSettings>) => {
					_settings = { ..._settings, ...update };
					saveSettings(_settings);
					info(`设置已更新: ${JSON.stringify(update)}`);
					// 广播给所有 follower，保持内存状态一致
					_ipcServer?.broadcast({ type: "settings_changed", settings: _settings });
				},
				claimSession: (s: QBSession) => claimSession(s),
				getInstanceList: () => Object.values(readRegistry().instances),
				resolveInstance: (target) => resolveInstanceByName(target),
				rerouteTo: (targetId, s) => rerouteSession(targetId, s),
				injectTo: (targetId, s, c) => injectContent(targetId, s, c),
				getClaimer: (s) => findClaimer(`${s.type}:${s.id}`),
			});

			_ws = createWsClient(_auth, {
				onAuthFailed: () => {
					logError(`QQ Bot 鉴权失败 (InvalidSession)`);
					ctx.ui.notify("QQ Bot: 鉴权失败，请检查 appId/appSecret ❌", "error");
					teardown();
				},
			});
			_ws.onMessage((qqMsg) => {
				const sessionKey = `${qqMsg.session.type}:${qqMsg.session.id}`;
				// 引用消息（message_type=103）优先按被引用消息的来源实例路由
				let claimer: InstanceEntry | null = null;
				if (qqMsg.messageType === 103) {
					const routedId = resolveRouteInstance(qqMsg);
					if (routedId) {
						const inst = readRegistry().instances[routedId];
						if (inst && (routedId === _instanceId || _ipcServer?.has(routedId))) {
							claimer = inst;
							debug(`引用消息路由 -> 实例 ${inst.name ?? routedId} (ref=${qqMsg.refMsgIdx})`);
						}
					} else {
						debug(`引用消息未命中路由，走默认认领 (ref=${qqMsg.refMsgIdx}, content=${qqMsg.refMsgContent?.slice(0, 30)})`);
					}
				}
				if (!claimer) claimer = findClaimer(sessionKey);
				if (claimer && claimer.id !== _instanceId && _ipcServer?.has(claimer.id)) {
					const ok = _ipcServer.sendTo(claimer.id, {
						type: "inbound",
						session: qqMsg.session,
						content: qqMsg.content,
						fromTag: sessionTag(qqMsg.session.type),
					});
					if (ok) {
						debug(`QQ 入站转发给实例 ${claimer.name ?? claimer.id}`);
						return;
					}
				}
				handleInboundQqMessage(qqMsg);
			});
			_ws.onEvent((event) => {
				debug(`QQ 事件: ${event}`);
			});

			// 启动 IPC 服务，接收 follower 的注册/认领/出站请求
			_ipcServer = createIpcServer(LEADER_SOCK_PATH, {
				onRegister: (entry) => {
					// 基本结构校验，防伪造实例条目
					if (
						!entry ||
						typeof entry.id !== "string" ||
						entry.id.length === 0 ||
						entry.id.length > 128 ||
						!Number.isInteger(entry.pid) ||
						(entry.role !== "leader" && entry.role !== "follower") ||
						!Array.isArray(entry.claimedSessions)
					) {
						logError("register 拒绝: 非法实例条目");
						return;
					}
					// session 参考名清洗（仅展示用，不参与区分/路由）；空名置 undefined
					const cleaned = entry.name ? sanitizeDisplayName(entry.name) : "";
					upsertInstance({ ...entry, name: cleaned || undefined });
				},
				onClaim: (sessionKey, instanceId) => {
					if (!isValidSessionKey(sessionKey)) {
						logError(`claim 拒绝: 非法 sessionKey ${sessionKey}`);
						return;
					}
					setClaim(instanceId, sessionKey);
				},
				onOutbound: (msg, instanceId) => {
					if (_api) {
						_api.sendMarkdown(msg.target, msg.content, msg.replyTo)
							.then((resp) => trackSentRef(resp, instanceId))
							.catch((e) => logError(`leader 转发失败: ${e}`));
					}
				},
				onInstanceUpdate: (name, instanceId) => {
					const inst = readRegistry().instances[instanceId];
					if (!inst) {
						logError(`instance_update 拒绝: 未知实例 ${instanceId}`);
						return;
					}
					// session 参考名清洗（仅展示用）
					const cleaned = sanitizeDisplayName(name);
					upsertInstance({ ...inst, name: cleaned || undefined });
					if (cleaned) debug(`实例 ${instanceId} session 参考名更新: ${cleaned}`);
				},
				onReroute: (sessionKey, targetId, fromId) => {
					if (!isValidSessionKey(sessionKey) || typeof targetId !== "string" || !targetId || targetId.length > 128) {
						logError(`reroute 拒绝: 非法参数`);
						return;
					}
					// 权限：请求方必须是当前 claimer（或会话无主），防任意挪动认领
					const cur = findClaimer(sessionKey);
					if (cur && cur.id !== fromId) {
						logError(`reroute 拒绝: 会话 ${sessionKey} 由 ${cur.id} 认领，非请求方 ${fromId}`);
						return;
					}
					const reg = readRegistry();
					const target = reg.instances[targetId];
					if (target && (targetId === _instanceId || _ipcServer?.has(targetId))) {
						setClaim(targetId, sessionKey);
						debug(`会话 ${sessionKey} 认领已切换到实例 ${target.name ?? targetId}`);
					} else {
						logError(`reroute 目标实例不可用: ${targetId}`);
					}
				},
				onInject: (session, content, fromId) => {
					if (!isValidSession(session) || typeof content !== "string" || content.length === 0 || content.length > 4000) {
						logError(`inject 拒绝: 非法参数`);
						return;
					}
					const sessionKey = `${session.type}:${session.id}`;
					// 按当前认领路由；内容本身仍走 isAllowed 白名单（与 QQ 消息同级防线）
					const claimer = findClaimer(sessionKey);
					if (claimer && claimer.id !== _instanceId && _ipcServer?.has(claimer.id)) {
						_ipcServer.sendTo(claimer.id, {
							type: "inbound",
							session,
							content,
							fromTag: sessionTag(session.type),
						});
						return;
					}
					handleInboundQqMessage({ session, content });
				},
				onDisconnect: (instanceId) => {
					debug(`follower ${instanceId} 连接断开（保留认领，待重连恢复）`);
				},
				// follower 请求当前 settings（新 follower 连接后同步状态）
				onSettingsRequest: (instanceId) => {
					_ipcServer?.sendTo(instanceId, { type: "settings_changed", settings: _settings });
				},
				// follower 发起 settings 变更请求（#settings 命令路由到 leader）
				onSettingsUpdate: (settings, instanceId) => {
					if (!isValidSettings(settings)) {
						logError(`follower ${instanceId} 发来非法 settings，已忽略`);
						return;
					}
					// forwardToolCalls 与 lastMessageOnly 互斥
					const normalized = settings.forwardToolCalls && settings.lastMessageOnly
						? { ...settings, lastMessageOnly: false }
						: settings;
					_settings = normalized;
					saveSettings(_settings);
					info(`follower ${instanceId} 触发 settings 同步: ${JSON.stringify(normalized)}`);
					// 广播给所有 follower
					_ipcServer?.broadcast({ type: "settings_changed", settings: _settings });
				},
			});
			await _ipcServer.ready;
			setLeader(_instanceId, LEADER_SOCK_PATH);
			upsertInstance(selfEntry("leader"));
			// 立即执行一次 pruneDead，清理上次残留的死实例
			pruneDead();
			touchInstance(_instanceId);
			_registryTimer = setInterval(() => {
				pruneDead();
				touchInstance(_instanceId);
			}, HEARTBEAT_INTERVAL_MS);

			await _ws.connect();
			ctx.ui.notify("QQ Bot: 已连接 ✅（leader）", "info");
		} catch (err) {
			logError(`初始化失败: ${err}`);
			ctx.ui.notify(`QQ Bot: 连接失败 ❌ — ${(err as Error).message}`, "error");
			// 失败时清掉半初始化状态，避免残留 _role=leader / 锁心跳导致其它实例卡在 follower
			await teardown();
		}
	}

	async function becomeFollower(ctx: ExtensionContext): Promise<void> {
		_role = "follower";
		_followerStop = false;
		ctx.ui.notify("QQ Bot: 作为 follower 连接 leader...", "info");

		// follower 没有真实 QQ 连接：所有出站都经 IPC 转给 leader 代发
		const followerApi: ApiClient = {
			async sendMarkdown(session, markdown, replyTo, opts) {
				await sendToQq(session, markdown, replyTo, opts);
				return {} as SendMessageResponse;
			},
			async sendText(session, text, replyTo, opts) {
				await sendToQq(session, text, replyTo, opts);
				return {} as SendMessageResponse;
			},
			async sendMessage(session, text, options, opts) {
				await sendToQq(
					session,
					text,
					options ? { msgId: options.msgId, eventId: options.eventId } : undefined,
					opts,
				);
				return {} as SendMessageResponse;
			},
		};

		_sm = createSessionManager();
		_cmdHandler = createCommandHandler(followerApi, _sm, {
			sendUserMessage: (text: string) => pi.sendUserMessage(text),
			switchSession: () => {},
			newSession: () => {},
			clearSession: () => {},
			getSettings: () => _settings,
			updateSettings: (update: Partial<QqSettings>) => {
				// follower 不直接修改，而是通过 IPC 请求 leader 执行变更后广播
				const merged = { ..._settings, ...update };
				if (_ipcClient) {
					_ipcClient.send({ type: "settings_update", settings: merged });
					info(`settings 变更已发送给 leader 处理: ${JSON.stringify(update)}`);
				} else {
					// IPC 未连接时回退到本地修改
					_settings = merged;
					saveSettings(_settings);
					info(`设置已更新（本地）: ${JSON.stringify(update)}`);
				}
			},
			claimSession: (s: QBSession) => claimSession(s),
			getInstanceList: () => Object.values(readRegistry().instances),
			resolveInstance: (target) => resolveInstanceByName(target),
			rerouteTo: (targetId, s) => rerouteSession(targetId, s),
			injectTo: (targetId, s, c) => injectContent(targetId, s, c),
			getClaimer: (s) => findClaimer(`${s.type}:${s.id}`),
		});

		tryFollower(ctx);
	}

	function tryFollower(ctx: ExtensionContext): void {
		if (_followerStop) return;
		if (_ipcClient) {
			try { _ipcClient.close(); } catch { /* 忽略已断开的 client */ }
			_ipcClient = null;
		}
		const sock = getLeaderSock();
		if (!sock) {
			// 无 leader 可连：仅首次通知一次，后续重试静默
			if (!_leaderDisconnectNotified) {
				_leaderDisconnectNotified = true;
				ctx.ui.notify("QQ Bot: 未找到 leader，正在重连...", "info");
			}
			scheduleRetryFollower(ctx);
			return;
		}
		const client = createIpcClient(sock, {
			onConnect: () => {
				_leaderDisconnectNotified = false; // 连接恢复，重置去重标志
				client.send({ type: "register", entry: selfEntry("follower") });
				// 同步 leader 的 settings 状态
				client.send({ type: "settings_request" });
				info(`已连接 leader（follower）`);
				ctx.ui.notify("QQ Bot: 已连接 leader ✅（follower）", "info");
				_followerRetryDelay = DEFAULTS.FOLLOWER_RETRY_MS; // 重置退避
			},
			onInbound: (msg) => {
				handleInboundQqMessage({ session: msg.session, content: msg.content });
			},
			onSettingsChanged: (settings) => {
				_settings = settings;
				info(`settings 已从 leader 同步: ${JSON.stringify(settings)}`);
			},
			onClose: () => {
				if (_followerStop) return;
				// 去重：只在首次断开时通知（error+close 双触发、重连循环都不再重复弹）
				if (!_leaderDisconnectNotified) {
					_leaderDisconnectNotified = true;
					ctx.ui.notify("QQ Bot: 与 leader 断开，正在重连...", "info");
				}
				scheduleRetryFollower(ctx);
			},
		});
		_ipcClient = client;
	}

	function scheduleRetryFollower(ctx: ExtensionContext): void {
		if (_followerStop || _followerRetryTimer) return;
		const delay = _followerRetryDelay;
		_followerRetryDelay = Math.min(delay * 2, 30_000); // 上限 30 秒
		debug(`follower 将在 ${delay}ms 后重试`);
		_followerRetryTimer = setTimeout(() => {
			_followerRetryTimer = null;
			if (_followerStop) return;
			tryFollower(ctx);
		}, delay);
	}

	async function sendToQq(
		target: QBSession,
		content: string,
		replyTo?: { msgId?: string; eventId?: string },
		opts?: { claim?: boolean },
	): Promise<void> {
		if (opts?.claim !== false) claimSession(target);
		const signed = decorate(content);
		if (_role === "leader" && _api) {
			try {
				const resp = await _api.sendMarkdown(target, signed, replyTo);
				trackSentRef(resp, _instanceId);
			} catch (err) {
				logError(`回复发送失败: ${err}`);
			}
		} else if (_role === "follower" && _ipcClient) {
			_ipcClient.send({ type: "outbound", target, content: signed, replyTo });
		} else {
			debug(`sendToQq 跳过: role=${_role}, api=${!!_api}`);
		}
	}

	function claimSession(session: QBSession): void {
		const key = `${session.type}:${session.id}`;
		if (_role === "leader") setClaim(_instanceId, key);
		else if (_role === "follower" && _ipcClient) _ipcClient.send({ type: "claim", sessionKey: key });
	}

	// ── QQ 消息白名单（H1：防远程提示词注入/RCE）──
	let _allowlistWarned = false;
	function isAllowed(session: QBSession): boolean {
		// 只允许已知会话类型，未知类型一律拒绝（防伪造类型绕过白名单）
		if (session.type !== "c2c" && session.type !== "group" && session.type !== "channel") {
			return false;
		}
		const users = config.allowedUsers;
		const groups = config.allowedGroups;
		const hasUsers = !!(users && users.length > 0);
		const hasGroups = !!(groups && groups.length > 0);
		if (!hasUsers && !hasGroups) {
			// 未配置白名单：默认放行，但首次告警
			if (!_allowlistWarned) {
				_allowlistWarned = true;
				warn("未配置 allowedUsers/allowedGroups 白名单，所有 QQ 消息均会被注入 pi（存在远程命令执行风险）。建议在配置文件中设置白名单。");
			}
			return true;
		}
		if (session.type === "c2c") return hasUsers ? users!.includes(session.id) : true;
		if (session.type === "group") return hasGroups ? groups!.includes(session.id) : true;
		return true; // channel 默认放行
	}

	/** 校验 follower 经 IPC 发来的 settings 结构，防注入畸形数据 */
	function isValidSettings(s: unknown): s is QqSettings {
		if (!s || typeof s !== "object") return false;
		const o = s as Record<string, unknown>;
		if (typeof o.forwardDesktopMessages !== "boolean") return false;
		if (typeof o.forwardToolCalls !== "boolean") return false;
		if (typeof o.lastMessageOnly !== "boolean") return false;
		if (o.defaultSession !== undefined && (typeof o.defaultSession !== "object" || o.defaultSession === null)) return false;
		return true;
	}

	// ── IPC 入站数据校验（与 isValidSettings 同范式，防注入畸形数据）──

	/** session.id 仅允许安全字符（与 api-client 一致） */
	const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

	/** 校验 QQ 会话对象结构（inject 等 IPC 入站数据） */
	function isValidSession(s: unknown): s is QBSession {
		if (!s || typeof s !== "object") return false;
		const o = s as Record<string, unknown>;
		if (o.type !== "c2c" && o.type !== "group" && o.type !== "channel") return false;
		if (typeof o.id !== "string" || !SESSION_ID_RE.test(o.id)) return false;
		if (o.name !== undefined && typeof o.name !== "string") return false;
		if (o.userId !== undefined && typeof o.userId !== "string") return false;
		if (o.msgId !== undefined && typeof o.msgId !== "string") return false;
		if (o.eventId !== undefined && typeof o.eventId !== "string") return false;
		return true;
	}

	/** 校验会话认领 key 格式（c2c|group|channel:id） */
	function isValidSessionKey(key: string): boolean {
		const idx = key.indexOf(":");
		if (idx <= 0) return false;
		const type = key.slice(0, idx);
		const id = key.slice(idx + 1);
		return (type === "c2c" || type === "group" || type === "channel") && SESSION_ID_RE.test(id);
	}

	/** 清洗参考名：去控制字符/换行，限制长度，避免破坏 markdown 展示 */
	function sanitizeDisplayName(name: string | undefined): string {
		if (!name) return "";
		return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
	}

	async function handleInboundQqMessage(qqMsg: { session: QBSession; content: string }): Promise<void> {
		if (!isAllowed(qqMsg.session)) {
			warn(`拒绝非白名单消息: ${qqMsg.session.type}/${qqMsg.session.id}`);
			return;
		}
		_lastActiveQqSession = qqMsg.session;
		const sessionChanged =
			!_settings.defaultSession ||
			_settings.defaultSession.type !== qqMsg.session.type ||
			_settings.defaultSession.id !== qqMsg.session.id;
		if (sessionChanged) {
			_settings = { ..._settings, defaultSession: qqMsg.session };
			saveSettings(_settings);
			info(`默认会话已更新: ${qqMsg.session.type}/${qqMsg.session.id}`);
		} else if (_settings.defaultSession) {
			const existing = _settings.defaultSession;
			_settings = {
				..._settings,
				defaultSession: {
					type: existing.type,
					id: existing.id,
					name: existing.name,
					userId: existing.userId,
					msgId: qqMsg.session.msgId,
					eventId: qqMsg.session.eventId,
				},
			};
			saveSettings(_settings);
		}
		claimSession(qqMsg.session);
		debug(`收到 QQ 消息: [${qqMsg.session.type}] ${qqMsg.content.slice(0, DEFAULTS.CONTENT_PREVIEW_LEN)}`);

		const handled = _cmdHandler?.tryHandle(qqMsg.content, qqMsg.session);
		if (handled) {
			handled.then((isCmd) => {
				if (!isCmd) {
					const fromTag = sessionTag(qqMsg.session.type);
					pi.sendUserMessage(`[${fromTag}] ${qqMsg.content}`);
					info(`转发到 pi: [${fromTag}] ${qqMsg.content.slice(0, DEFAULTS.CONTENT_PREVIEW_LEN)}`);
				} else {
					debug(`QQ 命令已处理: ${qqMsg.content}`);
				}
			}).catch((e) => logError(`QQ 命令处理失败: ${e}`));
		} else {
			// 无命令处理器兜底：当作普通消息转发给 pi
			const fromTag = sessionTag(qqMsg.session.type);
			pi.sendUserMessage(`[${fromTag}] ${qqMsg.content}`);
		}
	}

async function disconnect(ctx: ExtensionContext): Promise<void> {
		await teardown();
		ctx.ui.notify("QQ Bot: 已断开 🔌", "info");
	}

	async function teardown(): Promise<void> {
		if (_ws) {
			_ws.disconnect();
			_ws = null;
		}
		_auth?.stopRefresh();
		_auth = null;
		_api = null;
		_sm = null;
		_cmdHandler = null;
		_lastAssistantContent = null;
		lock.stopHeartbeat();
		if (_registryTimer) {
			clearInterval(_registryTimer);
			_registryTimer = null;
		}
		if (_ipcServer) {
			_ipcServer.close();
			_ipcServer = null;
		}
		if (_ipcClient) {
			_ipcClient.close();
			_ipcClient = null;
		}
		_followerStop = true;
		if (_followerRetryTimer) {
			clearTimeout(_followerRetryTimer);
			_followerRetryTimer = null;
		}
		if (_role === "leader") {
			clearLeader();
		}
		// 无论角色都清理自己的 registry 条目
		removeInstance(_instanceId);
		_role = null;
		if (lock.getDiagnostics().isOwner) await lock.release();
	}

	// ── Slash 命令 ──

	pi.registerCommand("qq-connect", {
		description: "连接 QQ Bot",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (_role) {
				ctx.ui.notify("QQ Bot: 已经连接了", "info");
				return;
			}
			await connect(ctx);
		},
	});

	pi.registerCommand("qq-disconnect", {
		description: "断开 QQ Bot",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!_role) {
				ctx.ui.notify("QQ Bot: 未连接", "info");
				return;
			}
			await disconnect(ctx);
		},
	});

	pi.registerCommand("qq-status", {
		description: "查看连接状态概览",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lockDiag = lock.getDiagnostics();
			const wsDiag = _ws?.getDiagnostics();
			const authDiag = _auth?.getDiagnostics();
			const lines: string[] = [];

			lines.push(
				`${lockDiag.isOwner ? "🔒" : "🔓"} **锁**: ${lockDiag.isOwner ? "持有中" : "未持有"}`,
			);
			lines.push(
				`👥 **角色**: ${_role ? (_role === "leader" ? "🔑 leader（持有 QQ 连接）" : "👤 follower（经 IPC 委派）") : "未连接"}`,
			);

			if (wsDiag) {
				lines.push(
					`${wsDiag.connected ? "🟢" : "🔴"} **WebSocket**: ${stateLabel(wsDiag.state)}`,
				);
				if (wsDiag.uptimeMs !== null)
					lines.push(`⏱ **已运行**: ${formatDuration(wsDiag.uptimeMs)}`);
			} else {
				lines.push("⚪ **WebSocket**: 未连接（用 `/qq-connect` 连接）");
			}

			if (authDiag) {
				const ok = authDiag.hasToken && (authDiag.expiresInMs ?? 0) > 0;
				const failInfo = authDiag.consecutiveRefreshFailures > 0
					? ` (刷新失败 ${authDiag.consecutiveRefreshFailures} 次)`
					: "";
				lines.push(`${ok ? "✅" : "❌"} **Token**: ${ok ? "有效" : "无效"}${failInfo}`);
			} else {
				lines.push("⚪ **Token**: 未初始化");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("qq-diagnose", {
		description: "查看详细诊断信息",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lockDiag = lock.getDiagnostics();
			const wsDiag = _ws?.getDiagnostics();
			const authDiag = _auth?.getDiagnostics();
			const lines: string[] = [];

			lines.push("**🔒 锁状态**");
			lines.push(`- 持有锁: ${lockDiag.isOwner ? "✅ 是" : "❌ 否"}`);
			lines.push(`- 锁文件存在: ${lockDiag.lockExists ? "✅" : "❌"}`);
			lines.push(`- 锁文件 PID: ${lockDiag.currentPid ?? "(无)"}`);
			lines.push(`- 本进程 PID: ${process.pid}`);
			lines.push(`- 心跳活跃: ${lockDiag.heartbeatActive ? "✅" : "❌"}`);
			lines.push("");
			lines.push("**🌐 WebSocket 连接**");
			if (wsDiag) {
				lines.push(`- 状态: ${stateLabel(wsDiag.state)}`);
				lines.push(`- Session ID: ${wsDiag.sessionId ?? "(无)"}`);
				lines.push(`- 序列号: ${wsDiag.sequenceNumber}`);
				lines.push(`- 心跳间隔: ${wsDiag.heartbeatIntervalMs}ms`);
				lines.push(
					`- 上次心跳 ACK: ${wsDiag.lastHeartbeatAck ? new Date(wsDiag.lastHeartbeatAck).toLocaleTimeString("zh-CN") : "(无)"}`,
				);
				lines.push(
					`- 运行时长: ${wsDiag.uptimeMs !== null ? formatDuration(wsDiag.uptimeMs) : "(无)"}`,
				);
				lines.push(`- 重连次数: ${wsDiag.reconnectCount}`);
			} else {
				lines.push("- 未连接（用 `/qq-connect` 连接）");
			}
			lines.push("");
			lines.push("**🔑 Access Token**");
			if (authDiag) {
				lines.push(`- 有 Token: ${authDiag.hasToken ? "✅" : "❌"}`);
				lines.push(
					`- 过期时间: ${authDiag.expiresAt ? new Date(authDiag.expiresAt).toLocaleString("zh-CN") : "(无)"}`,
				);
				lines.push(
					`- 剩余时间: ${authDiag.expiresInMs !== null ? formatDuration(authDiag.expiresInMs) : "(无)"}`,
				);
				lines.push(
					`- 上次刷新: ${authDiag.lastRefreshTime ? new Date(authDiag.lastRefreshTime).toLocaleString("zh-CN") : "(未刷新)"}`,
				);
				if (authDiag.consecutiveRefreshFailures > 0) {
					lines.push(
						`- ⚠️ 连续刷新失败: ${authDiag.consecutiveRefreshFailures} 次`,
					);
				}
			} else {
				lines.push("- 未初始化");
			}
			lines.push("");
			lines.push("**⚙️ 配置**");
			lines.push(`- AppID: \`${config?.appId ?? "(无)"}\``);
			lines.push(`- 锁路径: \`${LOCK_PATH}\``);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("qq-logs", {
		description: "查看最近日志(30 条)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines = readRecentLines(30);
			if (lines.length === 0) {
				ctx.ui.notify("(无日志)", "info");
				return;
			}
			ctx.ui.notify(`日志文件: ${getLogPath()}\n\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("qq-logs-path", {
		description: "查看日志文件路径",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify(`日志文件: ${getLogPath()}`, "info");
		},
	});

	pi.registerCommand("qq-logs-clear", {
		description: "清空日志文件",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			clearLog();
			ctx.ui.notify(`日志已清空: ${getLogPath()}`, "info");
		},
	});

	pi.registerCommand("qq-target", {
		description: "设置/查看默认 QQ 转发目标",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			if (!sub || sub === "show") {
				const t = _settings.defaultSession;
				ctx.ui.notify(
					t
						? `默认目标: \`${t.type}\` \`${t.id}\` (${t.name})`
						: "未设置默认目标。发送一条 QQ 消息，或用 `/qq-target <c2c|group|channel> <id> [name]` 手动设置。",
					"info",
				);
				return;
			}

			if (sub === "clear") {
				_settings = { ..._settings, defaultSession: undefined };
				saveSettings(_settings);
				ctx.ui.notify("默认目标已清除", "info");
				return;
			}

			const validTypes = ["c2c", "group", "channel"];
			if (!validTypes.includes(sub)) {
				ctx.ui.notify(
					`类型必须是 c2c / group / channel / clear / show。用法: /qq-target c2c <openid> [备注]`,
					"warning",
				);
				return;
			}

			const id = parts[1];
			const name = parts.slice(2).join(" ") || id;
			if (!id) {
				ctx.ui.notify("缺少 ID。用法: /qq-target c2c <openid> [备注]", "warning");
				return;
			}

			const session: QBSession = { type: sub as QBSessionType, id, name };
			_settings = { ..._settings, defaultSession: session };
			saveSettings(_settings);
			ctx.ui.notify(
				`默认目标已设为: \`${sub}\` \`${id}\` (${name})`,
				"info",
			);
		},
	});

	// ── 事件 ──

	pi.on("session_start", async (event, ctx) => {
		// 刷新实例 session 参考名（当前活跃 pi session 名，仅展示用）
		updateSessionRef(ctx);
		// 启动自动连接（默认开启，可用配置 autoConnect:false 关闭）
		const autoConnect = config.autoConnect ?? true;
		if (!autoConnect) {
			debug("自动连接已禁用（autoConnect=false），跳过");
			return;
		}
		if (_role) {
			debug("已连接，跳过自动连接");
			return;
		}
		try {
			await connect(ctx);
		} catch (err) {
			logError(`自动连接失败: ${err}`);
		}
	});

	// 用户重命名/切换 session 后更新实例 session 参考名并同步 registry
	pi.on("session_info_changed", (event, ctx) => {
		updateSessionRef(ctx);
	});

	// 转发桌面端用户消息到 QQ
	pi.on("message_end", async (event: MessageEndEvent) => {
		if (event.message.role !== "user") {
			debug(`桌面转发跳过: role=${event.message.role}`);
			return;
		}
		if (!_settings.forwardDesktopMessages) {
			debug(`桌面转发跳过: forwardDesktopMessages=false`);
			return;
		}
		const target = _lastActiveQqSession ?? _settings.defaultSession;
		if (!target) {
			debug(`桌面转发跳过: 没有可用目标 (lastActive=${!!_lastActiveQqSession}, default=${!!_settings.defaultSession})`);
			return;
		}

		const content = extractTextFromContent(event.message.content);

		// 跳过来自 QQ 的消息本身（[QQ] 和 [QQ群] 开头）
		if (content.startsWith("[QQ")) {
			debug(`桌面转发跳过: 内容来自 QQ 前缀`);
			return;
		}
		if (!content.trim()) {
			debug(`桌面转发跳过: 内容为空 (raw=${JSON.stringify(event.message.content).slice(0, 200)})`);
			return;
		}

		const replyTo = target.msgId || target.eventId
			? { msgId: target.msgId, eventId: target.eventId }
			: undefined;
		info(`桌面端消息准备转发: target=${target.type}/${target.id}, replyTo=${JSON.stringify(replyTo)}, content=${content.slice(0, DEFAULTS.CONTENT_PREVIEW_LEN)}`);
		if (!replyTo) {
			warn(`桌面消息将以主动消息发送；若未收到，请检查 Bot 主动消息权限，或在 QQ 里发送 #target 刷新被动回复凭据`);
		}
		try {
			await sendToQq(target, `**🖥 桌面端:** ${content}`, replyTo);
			info(`桌面消息已转发到 QQ: ${content.slice(0, DEFAULTS.CONTENT_PREVIEW_LEN)}`);
		} catch (err) {
			logError(`桌面消息转发失败: ${err}`);
		}
	});

	// 转发 pi 回复到 QQ
	pi.on("message_end", async (event: MessageEndEvent) => {
		if (event.message.role !== "assistant") return;

		// 缓存最后一条 assistant 消息内容，供 agent_settled 使用（避免访问 stale ctx）
		_lastAssistantContent = event.message.content;

		// 开启 lastMessageOnly 时统一走 agent_settled，避免逐条重复转发
		if (_settings.lastMessageOnly) {
			debug(`pi 回复跳过: lastMessageOnly=true，等待 agent_settled 统一转发`);
			return;
		}

		const target = _lastActiveQqSession ?? _settings.defaultSession;
		if (!target) {
			debug(`pi 回复跳过: 没有可用目标`);
			return;
		}

		const content = extractTextFromContent(event.message.content);
		if (!content.trim()) return;

		debug(`pi 回复: ${content.slice(0, DEFAULTS.CONTENT_PREVIEW_LEN)}`);

		const replyTo = target.msgId || target.eventId
			? { msgId: target.msgId, eventId: target.eventId }
			: undefined;
		try {
			await sendToQq(target, content, replyTo);
			info(`已发回 QQ [${target.type}]: ${content.slice(0, DEFAULTS.CONTENT_PREVIEW_LEN)}`);
		} catch (err) {
			logError(`回复发送失败: ${err}`);
		}
	});

	// 当开启 lastMessageOnly 时，整次 agent 运行结束后只转发最后一条 assistant 回复（一次）
	pi.on("agent_settled", async (_event, _ctx) => {
		if (!_settings.lastMessageOnly) return;

		// 使用 message_end 缓存的最后一条 assistant 消息内容
		// （避免访问 ctx.sessionManager，因为 ctx 在 session replacement/reload 后会 stale）
		if (!_lastAssistantContent) {
			debug(`agent_settled 转发跳过: 无缓存的 assistant 消息`);
			return;
		}

		const target = _lastActiveQqSession ?? _settings.defaultSession;
		if (!target) {
			debug(`agent_settled 转发跳过: 没有可用目标`);
			return;
		}

		const content = extractTextFromContent(_lastAssistantContent);
		_lastAssistantContent = null; // 消费后清空，避免重复转发
		if (!content.trim()) {
			debug(`agent_settled 转发跳过: 内容为空`);
			return;
		}

		debug(`agent_settled 转发: ${content.slice(0, DEFAULTS.CONTENT_PREVIEW_LEN)}`);

		const replyTo = target.msgId || target.eventId
			? { msgId: target.msgId, eventId: target.eventId }
			: undefined;
		try {
			await sendToQq(target, content, replyTo);
			info(`已发回 QQ (最后一条) [${target.type}]: ${content.slice(0, DEFAULTS.CONTENT_PREVIEW_LEN)}`);
		} catch (err) {
			logError(`agent_settled 转发失败: ${err}`);
		}
	});

	// 转发工具调用到 QQ
	pi.on("tool_call", async (event: ToolCallEvent) => {
		if (!_settings.forwardToolCalls) return;

		const target = _lastActiveQqSession ?? _settings.defaultSession;
		if (!target) return;

		const toolName = event.toolName || "unknown";
		const input = event.input ?? {};
		const inputLines = formatToolInput(input);

		const replyTo = target.msgId || target.eventId
			? { msgId: target.msgId, eventId: target.eventId }
			: undefined;
		try {
			await sendToQq(
				target,
				`**🛠 ${toolName}**\n${inputLines}`,
				replyTo,
			);
			debug(`工具调用已转发到 QQ: ${toolName}`);
		} catch (err) {
			logError(`工具调用转发失败: ${err}`);
		}
	});

	// 转发工具执行结果到 QQ
	pi.on("tool_result", async (event: ToolResultEvent) => {
		if (!_settings.forwardToolCalls) return;

		const target = _lastActiveQqSession ?? _settings.defaultSession;
		if (!target) return;

		const text = extractTextFromContent(event.content);
		if (!text.trim()) return;

		const replyTo = target.msgId || target.eventId
			? { msgId: target.msgId, eventId: target.eventId }
			: undefined;
		try {
			await sendToQq(
				target,
				`**📤 结果** \n\`\`\`\n${text.replace(/`{3,}/g, "'''")}\n\`\`\``,
				replyTo,
			);
			debug(`工具结果已转发到 QQ`);
		} catch (err) {
			logError(`工具结果转发失败: ${err}`);
		}
	});

	pi.on("session_shutdown", async () => {
		await teardown();
	});
}
