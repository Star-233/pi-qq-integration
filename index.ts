import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { createLockManager } from "./lock";
import { createAuthManager, type AuthManager } from "./auth";
import { createWsClient, type WsClient } from "./ws-client";
import { createApiClient, type ApiClient } from "./api-client";
import { createSessionManager, type SessionManager } from "./session-manager";
import { createCommandHandler } from "./command-handler";
import type { QBSession } from "./types";
import { error as logError, info, debug, readRecentLines, getLogPath } from "./logger";

const LOCK_PATH = "/home/nullsky/.pi/agent/qq-integration.lock";
const HEARTBEAT_INTERVAL_MS = 30_000;

function stateLabel(state: string): string {
  switch (state) {
    case "connected": return "已连接";
    case "connecting": return "连接中";
    case "disconnected": return "已断开";
    case "closing": return "关闭中";
    default: return state;
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

  /** 消息队列：按序保留待回复的会话，避免快速连续发消息时丢失 */
  let _pendingReplies: QBSession[] = [];

  // ── 连接/断开 ──

  async function connect(ctx: any): Promise<void> {
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
      });

      _ws = createWsClient(_auth);

      _ws.onMessage((qqMsg) => {
        _pendingReplies.push(qqMsg.session);
        debug(`收到 QQ 消息: [${qqMsg.session.type}] ${qqMsg.content.slice(0, 100)}`);

        _cmdHandler?.tryHandle(qqMsg.content, qqMsg.session).then((isCmd) => {
          if (!isCmd) {
            const fromTag = qqMsg.session.type === "c2c" ? "QQ" : "QQ群";
            pi.sendUserMessage(`[${fromTag}] ${qqMsg.content}`);
            info(`转发到 pi: [${fromTag}] ${qqMsg.content.slice(0, 100)}`);
          } else {
            _pendingReplies.shift();
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

  async function disconnect(ctx: any): Promise<void> {
    if (_ws) { _ws.disconnect(); _ws = null; }
    _auth?.stopRefresh();
    _auth = null; _api = null; _sm = null; _cmdHandler = null;
    _pendingReplies = [];
    lock.stopHeartbeat();
    await lock.release();
    ctx.ui.notify("QQ Bot: 已断开 🔌", "info");
  }

  // ── Slash 命令 ──

  pi.registerCommand("qq-connect", {
    description: "连接 QQ Bot",
    handler: async (_args, ctx) => {
      if (_ws?.getDiagnostics().connected) {
        ctx.ui.notify("QQ Bot: 已经连接了", "info");
        return;
      }
      await connect(ctx);
    },
  });

  pi.registerCommand("qq-disconnect", {
    description: "断开 QQ Bot",
    handler: async (_args, ctx) => {
      if (!_ws) { ctx.ui.notify("QQ Bot: 未连接", "info"); return; }
      await disconnect(ctx);
    },
  });

  pi.registerCommand("qq-status", {
    description: "查看连接状态概览",
    handler: async (_args, ctx) => {
      const lockDiag = lock.getDiagnostics();
      const wsDiag = _ws?.getDiagnostics();
      const authDiag = _auth?.getDiagnostics();
      const lines: string[] = [];

      lines.push(`${lockDiag.isOwner ? "🔒" : "🔓"} **锁**: ${lockDiag.isOwner ? "持有中" : "未持有"}`);

      if (wsDiag) {
        lines.push(`${wsDiag.connected ? "🟢" : "🔴"} **WebSocket**: ${stateLabel(wsDiag.state)}`);
        if (wsDiag.uptimeMs !== null) lines.push(`⏱ **已运行**: ${formatDuration(wsDiag.uptimeMs)}`);
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
    handler: async (_args, ctx) => {
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
        lines.push(`- 上次心跳 ACK: ${wsDiag.lastHeartbeatAck ? new Date(wsDiag.lastHeartbeatAck).toLocaleTimeString("zh-CN") : "(无)"}`);
        lines.push(`- 运行时长: ${wsDiag.uptimeMs !== null ? formatDuration(wsDiag.uptimeMs) : "(无)"}`);
        lines.push(`- 重连次数: ${wsDiag.reconnectCount}`);
      } else {
        lines.push("- 未连接（用 `/qq-connect` 连接）");
      }
      lines.push("");
      lines.push("**🔑 Access Token**");
      if (authDiag) {
        lines.push(`- 有 Token: ${authDiag.hasToken ? "✅" : "❌"}`);
        lines.push(`- 过期时间: ${authDiag.expiresAt ? new Date(authDiag.expiresAt).toLocaleString("zh-CN") : "(无)"}`);
        lines.push(`- 剩余时间: ${authDiag.expiresInMs !== null ? formatDuration(authDiag.expiresInMs) : "(无)"}`);
        lines.push(`- 上次刷新: ${authDiag.lastRefreshTime ? new Date(authDiag.lastRefreshTime).toLocaleString("zh-CN") : "(未刷新)"}`);
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
    description: "查看最近日志（30 条）",
    handler: async (_args, ctx) => {
      const lines = readRecentLines(30);
      if (lines.length === 0) { ctx.ui.notify("(无日志)", "info"); return; }
      ctx.ui.notify(`日志文件: ${getLogPath()}\n\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("qq-logs-path", {
    description: "查看日志文件路径",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`日志文件: ${getLogPath()}`, "info");
    },
  });

  // ── 事件 ──

  pi.on("session_start", async () => {
    // 不再自动连接，提示用户
  });

  pi.on("message_end", async (event) => {
    if (_pendingReplies.length === 0) return;
    if (event.message.role !== "assistant") return;

    const content =
      typeof event.message.content === "string"
        ? event.message.content
        : Array.isArray(event.message.content)
          ? event.message.content
              .filter((p: { type?: string }) => p.type === "text")
              .map((p: { text?: string }) => p.text)
              .join("\n")
          : "";

    if (!content.trim()) return;

    debug(`pi 回复: ${content.slice(0, 100)}`);

    try {
      const target = _pendingReplies.shift()!;
      await _api?.sendMarkdown(target, content);
      info(`已发回 QQ [${target.type}]: ${content.slice(0, 100)}`);
    } catch (err) {
      logError(`回复发送失败: ${err}`);
    }
  });

  pi.on("session_shutdown", async () => {
    if (_ws) { _ws.disconnect(); _ws = null; }
    _auth?.stopRefresh();
    _auth = null; _api = null; _sm = null; _cmdHandler = null;
    _pendingReplies = [];
    lock.stopHeartbeat();
    await lock.release();
  });
}
