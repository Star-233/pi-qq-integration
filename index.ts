import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { createLockManager } from "./lock";
import { createAuthManager, type AuthManager } from "./auth";
import { createWsClient, type WsClient } from "./ws-client";
import { createApiClient, type ApiClient } from "./api-client";
import { createSessionManager, type SessionManager } from "./session-manager";
import { createCommandHandler } from "./command-handler";
import type { QBSession } from "./types";

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
  // ── 加载配置 ──
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    console.error("[QQ Bot]", (err as Error).message);
    return;
  }

  // ── 模块级状态 ──
  const lock = createLockManager(LOCK_PATH);
  let _ws: WsClient | null = null;
  let _auth: AuthManager | null = null;
  let _api: ApiClient | null = null;
  let _sm: SessionManager | null = null;
  let _cmdHandler: ReturnType<typeof createCommandHandler> | null = null;

  let _pendingReply: QBSession | null = null;

  // ── 连接/断开逻辑 ──

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
        _pendingReply = qqMsg.session;

        _cmdHandler?.tryHandle(qqMsg.content, qqMsg.session).then((isCmd) => {
          if (!isCmd) {
            const fromTag = qqMsg.session.type === "c2c" ? "QQ" : "QQ群";
            pi.sendUserMessage(`[${fromTag}] ${qqMsg.content}`);
          } else {
            _pendingReply = null;
          }
        });
      });

      _ws.onEvent((event) => {
        console.log(`[QQ Bot] 事件: ${event}`);
      });

      await _ws.connect();
      ctx.ui.notify("QQ Bot: 已连接 ✅", "info");
    } catch (err) {
      console.error("[QQ Bot] 初始化失败:", err);
      ctx.ui.notify(`QQ Bot: 连接失败 ❌ — ${(err as Error).message}`, "error");
    }
  }

  async function disconnect(ctx: any): Promise<void> {
    if (_ws) {
      _ws.disconnect();
      _ws = null;
    }
    _auth?.stopRefresh();
    _auth = null;
    _api = null;
    _sm = null;
    _cmdHandler = null;
    _pendingReply = null;

    lock.stopHeartbeat();
    await lock.release();
    ctx.ui.notify("QQ Bot: 已断开 🔌", "info");
  }

  // ================================================================
  // slash 命令
  // ================================================================

  pi.registerCommand("qq-connect", {
    description: "连接 QQ Bot（手动连接，不会自动连接）",
    handler: async (_args, ctx) => {
      if (_ws?.getDiagnostics().connected) {
        ctx.ui.notify("QQ Bot: 已经连接了", "info");
        return;
      }
      await connect(ctx);
    },
  });

  pi.registerCommand("qq-disconnect", {
    description: "断开 QQ Bot 连接",
    handler: async (_args, ctx) => {
      if (!_ws) {
        ctx.ui.notify("QQ Bot: 未连接", "info");
        return;
      }
      await disconnect(ctx);
    },
  });

  pi.registerCommand("qq-status", {
    description: "查看 QQ Bot 扩展连接状态概览",
    handler: async (_args, ctx) => {
      const lockDiag = lock.getDiagnostics();
      const wsDiag = _ws?.getDiagnostics();
      const authDiag = _auth?.getDiagnostics();

      const lines: string[] = [];

      const lockIcon = lockDiag.isOwner ? "🔒" : "🔓";
      lines.push(`${lockIcon} **锁**: ${lockDiag.isOwner ? "持有中" : "未持有"}`);

      if (wsDiag) {
        const wsIcon = wsDiag.connected ? "🟢" : "🔴";
        lines.push(`${wsIcon} **WebSocket**: ${stateLabel(wsDiag.state)}`);
        if (wsDiag.uptimeMs !== null) {
          lines.push(`⏱ **已运行**: ${formatDuration(wsDiag.uptimeMs)}`);
        }
      } else {
        lines.push("⚪ **WebSocket**: 未连接（用 `/qq-connect` 连接）");
      }

      if (authDiag) {
        const tokenOk = authDiag.hasToken && (authDiag.expiresInMs ?? 0) > 0;
        lines.push(`${tokenOk ? "✅" : "❌"} **Token**: ${tokenOk ? "有效" : "无效"}`);
      } else {
        lines.push("⚪ **Token**: 未初始化");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("qq-diagnose", {
    description: "查看 QQ Bot 扩展详细诊断信息",
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

  // ================================================================
  // 事件
  // ================================================================

  // session_start 不再自动连接，等待用户手动 /qq-connect
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("QQ Bot: 用 `/qq-connect` 连接，`/qq-disconnect` 断开", "info");
  });

  // message_end — 捕获 pi 的回复，回传 QQ
  pi.on("message_end", async (event) => {
    if (!_pendingReply) return;
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

    try {
      await _api?.sendMarkdown(_pendingReply, content);
    } catch (err) {
      console.error("[QQ Bot] 回复发送失败:", err);
    } finally {
      _pendingReply = null;
    }
  });

  // session_shutdown — 清理资源
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
    _pendingReply = null;

    lock.stopHeartbeat();
    await lock.release();
  });
}
