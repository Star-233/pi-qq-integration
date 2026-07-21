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

// ── 辅助函数 ──

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

  /** 待回复的 QQ 会话（有值表示下一次 assistant 回复需要发到 QQ） */
  let _pendingReply: QBSession | null = null;

  // ================================================================
  // slash 命令注册 — 无论 session 是否存在都可使用
  // ================================================================

  pi.registerCommand("qq-status", {
    description: "查看 QQ Bot 扩展连接状态概览",
    handler: async (_args, ctx) => {
      const lockDiag = lock.getDiagnostics();
      const wsDiag = _ws?.getDiagnostics();
      const authDiag = _auth?.getDiagnostics();

      const lines: string[] = [];

      // 锁状态
      const lockIcon = lockDiag.isOwner ? "🔒" : "🔓";
      lines.push(`${lockIcon} **锁**: ${lockDiag.isOwner ? "持有中" : "未持有"}`);

      // WebSocket 状态
      if (wsDiag) {
        const wsIcon = wsDiag.connected ? "🟢" : "🔴";
        lines.push(`${wsIcon} **WebSocket**: ${stateLabel(wsDiag.state)}`);
        if (wsDiag.uptimeMs !== null) {
          lines.push(`⏱ **已运行**: ${formatDuration(wsDiag.uptimeMs)}`);
        }
      } else {
        lines.push("⚪ **WebSocket**: 未初始化");
      }

      // Token 状态
      if (authDiag) {
        const tokenOk = authDiag.hasToken && (authDiag.expiresInMs ?? 0) > 0;
        const tokenIcon = tokenOk ? "✅" : "❌";
        lines.push(`${tokenIcon} **Token**: ${tokenOk ? "有效" : "无效"}`);
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

      // ── 锁信息 ──
      lines.push("**🔒 锁状态**");
      lines.push(`- 持有锁: ${lockDiag.isOwner ? "✅ 是" : "❌ 否"}`);
      lines.push(`- 锁文件存在: ${lockDiag.lockExists ? "✅" : "❌"}`);
      lines.push(`- 锁文件 PID: ${lockDiag.currentPid ?? "(无)"}`);
      lines.push(`- 本进程 PID: ${process.pid}`);
      lines.push(`- 心跳活跃: ${lockDiag.heartbeatActive ? "✅" : "❌"}`);
      lines.push("");

      // ── WebSocket 信息 ──
      lines.push("**🌐 WebSocket 连接**");
      if (wsDiag) {
        lines.push(`- 状态: ${stateLabel(wsDiag.state)}`);
        lines.push(`- Session ID: ${wsDiag.sessionId ?? "(无)"}`);
        lines.push(`- 序列号: ${wsDiag.sequenceNumber}`);
        lines.push(`- 心跳间隔: ${wsDiag.heartbeatIntervalMs}ms`);
        lines.push(
          `- 上次心跳 ACK: ${
            wsDiag.lastHeartbeatAck
              ? new Date(wsDiag.lastHeartbeatAck).toLocaleTimeString("zh-CN")
              : "(无)"
          }`
        );
        lines.push(
          `- 运行时长: ${
            wsDiag.uptimeMs !== null ? formatDuration(wsDiag.uptimeMs) : "(无)"
          }`
        );
        lines.push(`- 重连次数: ${wsDiag.reconnectCount}`);
      } else {
        lines.push("- 未初始化");
      }
      lines.push("");

      // ── Token 信息 ──
      lines.push("**🔑 Access Token**");
      if (authDiag) {
        lines.push(`- 有 Token: ${authDiag.hasToken ? "✅" : "❌"}`);
        lines.push(
          `- 过期时间: ${
            authDiag.expiresAt
              ? new Date(authDiag.expiresAt).toLocaleString("zh-CN")
              : "(无)"
          }`
        );
        lines.push(
          `- 剩余时间: ${
            authDiag.expiresInMs !== null ? formatDuration(authDiag.expiresInMs) : "(无)"
          }`
        );
        lines.push(
          `- 上次刷新: ${
            authDiag.lastRefreshTime
              ? new Date(authDiag.lastRefreshTime).toLocaleString("zh-CN")
              : "(未刷新)"
          }`
        );
      } else {
        lines.push("- 未初始化");
      }
      lines.push("");

      // ── 配置 ──
      lines.push("**⚙️ 配置**");
      lines.push(`- AppID: \`${config?.appId ?? "(无)"}\``);
      lines.push(`- 锁路径: \`${LOCK_PATH}\``);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ================================================================
  // session_start — 获取锁，初始化所有模块，连接 QQ Bot WSS
  // ================================================================
  pi.on("session_start", async (_event, ctx) => {
    const isOwner = await lock.acquire();
    if (!isOwner) {
      ctx.ui.notify("QQ Bot: 已有其他实例连接", "info");
      return;
    }

    // 拥有锁 → 启动
    lock.startHeartbeat(HEARTBEAT_INTERVAL_MS);
    ctx.ui.notify("QQ Bot: 正在连接...", "info");

    try {
      // 初始化认证和 API
      _auth = createAuthManager(config.appId, config.appSecret);
      await _auth.getToken();
      _auth.startRefresh();

      _api = createApiClient(_auth);
      _sm = createSessionManager();

      // 命令处理器
      const cmdHandler = createCommandHandler(_api, _sm, {
        sendUserMessage: (text: string) => pi.sendUserMessage(text),
        switchSession: (_name: string) => {
          /* 指引用户在终端操作 */
        },
        newSession: () => {
          /* 指引用户在终端操作 */
        },
        clearSession: () => {
          /* 指引用户在终端操作 */
        },
      });

      // QQ WebSocket 客户端
      _ws = createWsClient(_auth);

      // ── 收到 QQ 消息 ──
      _ws.onMessage((qqMsg) => {
        _pendingReply = qqMsg.session;

        cmdHandler.tryHandle(qqMsg.content, qqMsg.session).then((isCmd) => {
          if (!isCmd) {
            const fromTag = qqMsg.session.type === "c2c" ? "QQ好友" : "QQ群";
            pi.sendUserMessage(`[${fromTag}] ${qqMsg.content}`);
          } else {
            // 命令已处理，不需要回复到 QQ
            _pendingReply = null;
          }
        });
      });

      // ── 收到 QQ 系统事件 ──
      _ws.onEvent((event, data) => {
        console.log(`[QQ Bot] 事件: ${event}`);
      });

      await _ws.connect();
      ctx.ui.notify("QQ Bot: 已连接 ✅", "info");
    } catch (err) {
      console.error("[QQ Bot] 初始化失败:", err);
      ctx.ui.notify(`QQ Bot: 连接失败 ❌ — ${(err as Error).message}`, "error");
    }
  });

  // ================================================================
  // message_end — 捕获 pi 的 assistant 回复，回传 QQ
  // ================================================================
  pi.on("message_end", async (event) => {
    if (!_pendingReply) return;
    if (event.message.role !== "assistant") return;

    // 取文本内容（跳过只有 tool_calls 的中间消息）
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

    // 发送到 QQ
    try {
      await _api?.sendMarkdown(_pendingReply, content);
    } catch (err) {
      console.error("[QQ Bot] 回复发送失败:", err);
    } finally {
      // 重置待回复标记，避免后续 assistant 消息重复发送
      _pendingReply = null;
    }
  });

  // ================================================================
  // session_shutdown — 断开 QQ Bot 并释放锁
  // ================================================================
  pi.on("session_shutdown", async () => {
    if (_ws) {
      _ws.disconnect();
      _ws = null;
    }
    _auth?.stopRefresh();
    _auth = null;
    _api = null;
    _sm = null;
    _pendingReply = null;

    lock.stopHeartbeat();
    await lock.release();
  });
}
