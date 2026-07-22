import type {
	ExtensionAPI,
	ExtensionCommandContext,
	MessageEndEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { loadSettings, saveSettings } from "./config.js";
import { createLockManager } from "./lock.js";
import { createAuthManager, type AuthManager } from "./auth.js";
import { createWsClient, type WsClient } from "./ws-client.js";
import { createApiClient, type ApiClient } from "./api-client.js";
import { createSessionManager, type SessionManager } from "./session-manager.js";
import { createCommandHandler } from "./command-handler.js";
import type { QBSession, QBSessionType, QqSettings } from "./types.js";
import {
	error as logError,
	info,
	debug,
	readRecentLines,
	getLogPath,
} from "./logger.js";

const LOCK_PATH = "/home/nullsky/.pi/agent/qq-integration.lock";
const HEARTBEAT_INTERVAL_MS = 30_000;

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

export default function (pi: ExtensionAPI) {
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig();
	} catch (err) {
		logError(`配置加载失败: ${(err as Error).message}`);
		return;
	}

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

	/** 消息队列：按序保留待回复的会话，避免快速连续发消息时丢失 */
	let _pendingReplies: QBSession[] = [];

	// ── 连接/断开 ──

	async function connect(ctx: ExtensionCommandContext): Promise<void> {
		const isOwner = await lock.acquire();
		if (!isOwner) {
			ctx.ui.notify("QQ Bot: 锁被其他 pi 实例持有", "warning");
			return;
		}

		lock.startHeartbeat(HEARTBEAT_INTERVAL_MS);
		ctx.ui.notify("QQ Bot: 正在连接...", "info");

		try {
			_auth = createAuthManager(config.appId, config.appSecret);
			await _auth.getToken();
			_auth.startRefresh();

			_api = createApiClient(_auth);
			_sm = createSessionManager();

			_cmdHandler = createCommandHandler(_api, _sm, {
				sendUserMessage: (text: string) => pi.sendUserMessage(text),
				switchSession: () => {},
				newSession: () => {},
				clearSession: () => {},
				getSettings: () => _settings,
				updateSettings: (update: Partial<QqSettings>) => {
					_settings = { ..._settings, ...update };
					saveSettings(_settings);
					info(`设置已更新: ${JSON.stringify(update)}`);
				},
			});

			_ws = createWsClient(_auth);

			_ws.onMessage((qqMsg) => {
				// 新消息开始新回合，之前的队列作废
				_pendingReplies = [qqMsg.session];
				_lastActiveQqSession = qqMsg.session;
				// 记忆默认会话，桌面端消息在 QQ 未发消息时也能转发
				if (
					!_settings.defaultSession ||
					_settings.defaultSession.type !== qqMsg.session.type ||
					_settings.defaultSession.id !== qqMsg.session.id
				) {
					_settings = { ..._settings, defaultSession: qqMsg.session };
					saveSettings(_settings);
				}
				debug(
					`收到 QQ 消息: [${qqMsg.session.type}] ${qqMsg.content.slice(0, 100)}`,
				);

				_cmdHandler?.tryHandle(qqMsg.content, qqMsg.session).then((isCmd) => {
					if (!isCmd) {
						const fromTag = qqMsg.session.type === "c2c" ? "QQ" : "QQ群";
						pi.sendUserMessage(`[${fromTag}] ${qqMsg.content}`);
						info(`转发到 pi: [${fromTag}] ${qqMsg.content.slice(0, 100)}`);
					} else {
						debug(`QQ 命令已处理: ${qqMsg.content}`);
					}
				});
			});

			_ws.onEvent((event) => {
				debug(`QQ 事件: ${event}`);
			});

			await _ws.connect();
			ctx.ui.notify("QQ Bot: 已连接 ✅", "info");
		} catch (err) {
			logError(`初始化失败: ${err}`);
			ctx.ui.notify(`QQ Bot: 连接失败 ❌ — ${(err as Error).message}`, "error");
		}
	}

	async function disconnect(ctx: ExtensionCommandContext): Promise<void> {
		if (_ws) {
			_ws.disconnect();
			_ws = null;
		}
		_auth?.stopRefresh();
		_auth = null;
		_api = null;
		_sm = null;
		_cmdHandler = null;
		_pendingReplies = [];
		lock.stopHeartbeat();
		await lock.release();
		ctx.ui.notify("QQ Bot: 已断开 🔌", "info");
	}

	// ── Slash 命令 ──

	pi.registerCommand("qq-connect", {
		description: "连接 QQ Bot",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (_ws?.getDiagnostics().connected) {
				ctx.ui.notify("QQ Bot: 已经连接了", "info");
				return;
			}
			await connect(ctx);
		},
	});

	pi.registerCommand("qq-disconnect", {
		description: "断开 QQ Bot",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!_ws) {
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
				lines.push(`${ok ? "✅" : "❌"} **Token**: ${ok ? "有效" : "无效"}`);
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

	pi.on("session_start", async () => {
		// 不再自动连接，提示用户
	});

	// 转发桌面端用户消息到 QQ
	pi.on("message_end", async (event: MessageEndEvent) => {
		if (event.message.role !== "user") return;
		if (!_settings.forwardDesktopMessages) return;
		if (!_api) return;

		const target = _lastActiveQqSession ?? _settings.defaultSession;
		if (!target) return;

		const content =
			typeof event.message.content === "string" ? event.message.content : "";

		// 跳过来自 QQ 的消息本身（[QQ] 和 [QQ群] 开头）
		if (content.startsWith("[QQ")) return;
		if (!content.trim()) return;

		debug(`桌面端消息: ${content.slice(0, 100)}`);
		try {
			await _api.sendMarkdown(target, `**🖥 桌面端:** ${content}`);
			info(`桌面消息已转发到 QQ: ${content.slice(0, 100)}`);
		} catch (err) {
			logError(`桌面消息转发失败: ${err}`);
		}
	});

	// 转发 pi 回复到 QQ
	pi.on("message_end", async (event: MessageEndEvent) => {
		if (_pendingReplies.length === 0) return;
		if (event.message.role !== "assistant") return;

		const content = extractTextFromContent(event.message.content);

		if (!content.trim()) return;

		debug(`pi 回复: ${content.slice(0, 100)}`);

		try {
			const target = _pendingReplies[0];
			await _api?.sendMarkdown(target, content);
			info(`已发回 QQ [${target.type}]: ${content.slice(0, 100)}`);
		} catch (err) {
			logError(`回复发送失败: ${err}`);
		}
	});

	// 转发工具调用到 QQ
	pi.on("tool_call", async (event: ToolCallEvent) => {
		if (!_settings.forwardToolCalls) return;
		if (!_lastActiveQqSession || !_api) return;

		const toolName = event.toolName || "unknown";
		const input = event.input ?? {};
		const inputLines = formatToolInput(input);

		try {
			await _api.sendMarkdown(
				_lastActiveQqSession,
				`**🛠 ${toolName}**\n${inputLines}`,
			);
			debug(`工具调用已转发到 QQ: ${toolName}`);
		} catch (err) {
			logError(`工具调用转发失败: ${err}`);
		}
	});

	// 转发工具执行结果到 QQ
	pi.on("tool_result", async (event: ToolResultEvent) => {
		if (!_settings.forwardToolCalls) return;
		if (!_lastActiveQqSession || !_api) return;

		const text = extractTextFromContent(event.content);

		if (!text.trim()) return;

		try {
			await _api.sendMarkdown(
				_lastActiveQqSession,
				`**📤 结果** \n\`\`\`\n${text}\n\`\`\``,
			);
			debug(`工具结果已转发到 QQ`);
		} catch (err) {
			logError(`工具结果转发失败: ${err}`);
		}
	});

	pi.on("session_shutdown", async () => {
		if (_ws) {
			_ws.disconnect();
			_ws = null;
		}
		_auth?.stopRefresh();
		_auth = null;
		_api = null;
		_sm = null;
		_cmdHandler = null;
		_pendingReplies = [];
		lock.stopHeartbeat();
		await lock.release();
	});
}
