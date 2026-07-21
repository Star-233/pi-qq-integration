import type { ApiClient } from "./api-client";
import type { SessionManager } from "./session-manager";
import type { QBSession } from "./types";
import { debug } from "./logger";

/**
 * QQ 消息中的命令处理器。
 * 解析 /cmd args 格式的命令并执行。
 */
export function createCommandHandler(
  api: ApiClient,
  sessionManager: SessionManager,
  callbacks: {
    sendUserMessage: (text: string) => void;
    switchSession: (name: string) => void;
    newSession: () => void;
    clearSession: () => void;
  }
) {
  /**
   * 尝试将文本作为命令处理。
   * @returns true 如果文本是命令且已处理，false 表示不是命令需按 prompt 处理
   */
  async function tryHandle(
    text: string,
    from: QBSession
  ): Promise<boolean> {
    if (!text.startsWith("/")) return false;

    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1).join(" ");

    debug(`QQ 命令: /${cmd} ${args}`);

    switch (cmd) {
      case "help":
        await cmdHelp(from);
        return true;

      case "sessions":
        await cmdSessions(from);
        return true;

      case "resume":
        await cmdResume(from, args);
        return true;

      case "new":
        await cmdNew(from);
        return true;

      case "clear":
        await cmdClear(from);
        return true;

      case "history":
        await cmdHistory(from, args);
        return true;

      default:
        // 未知命令，不作为 prompt 处理
        await api.sendMarkdown(
          from,
          `未知命令 \`${cmd}\`。发送 \`/help\` 查看可用命令。`
        );
        return true;
    }
  }

  async function cmdHelp(session: QBSession): Promise<void> {
    await api.sendMarkdown(
      session,
      [
        "## 🤖 QQ Bot 帮助",
        "",
        "直接发送文字 → 发给 pi 作为 prompt",
        "",
        "**管理命令：**",
        "| 命令 | 说明 |",
        "|------|------|",
        "| `/help` | 显示此帮助 |",
        "| `/sessions` | 列出所有 pi session |",
        "| `/resume <序号/名称>` | 切换到指定 session（支持序号或名称匹配）|",
        "| `/new` | 创建新 session |",
        "| `/clear` | 清空当前 session |",
        "| `/history [N]` | 查看最近 N 条消息 (默认 10) |",
      ].join("\n")
    );
  }

  async function cmdSessions(session: QBSession): Promise<void> {
    const list = sessionManager.formatSessionList();
    debug(`/sessions: 返回 ${list.split("\n").length} 条`);
    await api.sendMarkdown(session, [
      "## 📋 Pi Sessions",
      "",
      list,
      "",
      "用 `/resume <序号>` 或 `/resume <名称>` 切换 session",
    ].join("\n"));
  }

  async function cmdResume(session: QBSession, arg: string): Promise<void> {
    if (!arg) {
      await api.sendText(session, "用法: `/resume <序号|名称>`");
      return;
    }

    const sessions = sessionManager.listSessions();
    let match: (typeof sessions)[0] | undefined;

    // 支持按序号匹配: /resume 1
    const idx = parseInt(arg, 10);
    if (idx > 0 && idx <= sessions.length) {
      match = sessions[idx - 1];
    } else {
      // 按名称、rawName 或路径匹配
      match = sessions.find(
        (s) =>
          s.name.includes(arg) ||
          s.rawName.includes(arg) ||
          s.projectDir.includes(arg)
      );
    }

    if (!match) {
      await api.sendMarkdown(
        session,
        `Session \`${arg}\` 不存在。用 \`/sessions\` 查看所有可用 session。`
      );
      return;
    }

    await api.sendMarkdown(
      session,
      `请在 pi 终端中输入 \`/resume ${match.rawName}\` 切换 session`
    );
  }

  async function cmdNew(session: QBSession): Promise<void> {
    await api.sendMarkdown(
      session,
      "请在 pi 终端中输入 `/new` 创建新 session"
    );
  }

  async function cmdClear(session: QBSession): Promise<void> {
    await api.sendText(
      session,
      "请在 pi 终端中输入 `/compact` 压缩对话"
    );
  }

  async function cmdHistory(session: QBSession, arg: string): Promise<void> {
    // 从当前 session 名读取
    const n = parseInt(arg, 10) || 5;

    // 获取当前 session 的信息 - 通过扫描找到最新的 session
    const sessions = sessionManager.listSessions();
    if (sessions.length === 0) {
      await api.sendText(session, "暂无 session");
      return;
    }

    // 当前活跃的一般是最近修改的 session
    const current = sessions[0];
    debug(`/history: session=${current.name}, count=${n}`);
    const preview = sessionManager.getSessionPreview(current.name, n);

    await api.sendMarkdown(
      session,
      [
        `## 📝 最近消息 (${current.name})`,
        "",
        preview,
      ].join("\n")
    );
  }

  return { tryHandle };
}

export type CommandHandler = ReturnType<typeof createCommandHandler>;
