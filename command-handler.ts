import type { ApiClient } from "./api-client.js";
import type { SessionManager } from "./session-manager.js";
import type { InstanceEntry, PiSessionInfo, QBSession, QqSettings } from "./types.js";
import { debug, info } from "./logger.js";
import { DEFAULTS } from "./constants.js";
import { homedir } from "node:os";

/** 转义用户可控内容，防止逃逸 Markdown 代码段/代码块/粗体 */
function esc(s: string): string {
  return s
    .replace(/`/g, "'")
    .replace(/\*/g, "\\*")
    .replace(/\n/g, " ");
}

/**
 * QQ 消息中的命令处理器。
 * 解析 #cmd args 格式的命令并执行。
 */
export function createCommandHandler(
  api: ApiClient,
  sessionManager: SessionManager,
  callbacks: {
    sendUserMessage: (text: string) => void;
    getSettings: () => QqSettings;
    updateSettings: (update: Partial<QqSettings>) => void;
    claimSession?: (session: QBSession) => void;
    // 多实例：实例列表 / 解析 / 定向路由
    getInstanceList?: () => InstanceEntry[];
    resolveInstance?: (target: string) => InstanceEntry | null;
    rerouteTo?: (targetId: string, session: QBSession) => boolean;
    injectTo?: (targetId: string, session: QBSession, content: string) => void;
    getClaimer?: (session: QBSession) => InstanceEntry | null;
    // 当前实例的 pi session 文件路径（#history 多实例场景：读当前实例而非全局最近 session）
    getCurrentSessionFile?: () => string | null;
    // 当前实例的工作目录（#create new 缺省目录）
    getCwd?: () => string | null;
    // #create：spawn 新 pi 实例（follower）
    spawnInstance?: (opts: {
      cwd: string;
      sessionPath?: string;
    }) => Promise<{ ok: boolean; pid?: number; error?: string }>;
    // #close：关闭指定实例（self=true 表示目标是自己）
    closeInstance?: (pid: number) => Promise<{
      ok: boolean;
      self?: boolean;
      error?: string;
    }>;
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
    if (!text.startsWith("#")) return false;

    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1).join(" ");

    debug(`QQ 命令: /${cmd} ${args}`);

    switch (cmd) {
      case "help":
        await cmdHelp(from);
        return true;

      case "sessions":
        await cmdSessions(from, args);
        return true;

      case "resume":
      case "new":
      case "clear":
        // 已移除：#create <序号/名称> 可创建复用指定 session 的新实例，
        // #create new 可创建全新 session 的实例，原 hack 命令不再需要
        await api.sendMarkdown(
          from,
          `\`#${cmd}\` 已移除。用 \`#create <序号/名称>\` 创建复用指定 session 的新实例，\`#create new [--dir <目录>]\` 创建全新 session 的实例。`
        );
        return true;

      case "history":
        await cmdHistory(from, args);
        return true;

      case "settings":
      case "setting":
        await cmdSettings(from, args);
        return true;

      case "target":
        await cmdTarget(from);
        return true;

      case "instances":
      case "instance":
        await cmdInstances(from);
        return true;

      case "to":
        await cmdTo(from, args);
        return true;

      default:
        // 未知命令，不作为 prompt 处理
        await api.sendMarkdown(
          from,
          `未知命令 \`${esc(cmd)}\`。发送 \`#help\` 查看可用命令。`
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
        "| `#help` | 显示此帮助 |",
        "| `#sessions [页码]` | 列出全部 session（按最近使用排序，每页 10 条）|",
        "| `#history [N]` | 查看最近 N 条消息 (默认 5) |",
        "| `#settings` | 查看/修改转发设置 |",
        "| `#target` | 将当前 QQ 会话设为默认转发目标 |",
        "| `#instances` | 列出所有在线 pi 实例 |",
        "| `#to <实例> [内容]` | 切换当前会话到指定实例（带内容则定向发送） |",
        "| `#create <序号/名称>` | 创建新实例并复用指定 session |",
        "| `#create new [--dir <目录>]` | 创建全新 session 的新实例（可指定工作目录）|",
        "| `#close <实例ID>` | 关闭指定实例 |",
      ].join("\n")
    );
  }

  async function cmdSessions(session: QBSession, arg: string): Promise<void> {
    const page = Math.max(1, parseInt(arg.trim(), 10) || 1);
    const { text, total, totalPages } = sessionManager.formatSessionListPage({
      page,
      pageSize: DEFAULTS.SESSION_PAGE_SIZE,
      currentFile: callbacks.getCurrentSessionFile?.() ?? null,
    });
    debug(`#sessions: 第 ${page}/${totalPages} 页`);
    await api.sendMarkdown(session, [
      "## 📋 Pi Sessions",
      "",
      text,
      "",
      `共 ${total} 条 · 第 ${page}/${totalPages} 页 · 用 \`#sessions <页码>\` 翻页`,
      "",
      "`#create <序号>` 用该 session 创建新实例",
    ].join("\n"));
  }

  /** 按序号或名称/路径匹配 session（与 #sessions 全量列表一致） */
  function resolveSession(
    arg: string,
    sessions: PiSessionInfo[]
  ): PiSessionInfo | undefined {
    const idx = parseInt(arg, 10);
    if (idx > 0 && idx <= sessions.length) return sessions[idx - 1];
    return sessions.find(
      (s) =>
        s.name.includes(arg) ||
        s.rawName.includes(arg) ||
        s.projectDir.includes(arg)
    );
  }

  /** ~ 展开为 home 目录 */
  function expandTilde(p: string): string {
    if (p === "~") return homedir();
    if (p.startsWith("~/")) return `${homedir()}${p.slice(1)}`;
    return p;
  }

  /** #create 结果回复 */
  async function replySpawnResult(
    session: QBSession,
    result: { ok: boolean; pid?: number; error?: string },
    label: string
  ): Promise<void> {
    if (result.ok && result.pid) {
      await api.sendMarkdown(
        session,
        `✅ 新实例 **${result.pid}** 已启动（${esc(label)}）。\n用 \`#to ${result.pid}\` 把当前会话切到该实例。`
      );
    } else {
      await api.sendMarkdown(session, `❌ 创建失败: ${esc(result.error ?? "未知错误")}`);
    }
  }

  async function cmdCreate(session: QBSession, arg: string): Promise<void> {
    const spawn = callbacks.spawnInstance;
    if (!spawn) {
      await api.sendMarkdown(session, "❌ 当前实例不支持 #create（仅 leader 可创建新实例）");
      return;
    }
    const trimmed = arg.trim();
    if (!trimmed) {
      await api.sendText(session, "用法: `#create <序号|名称>` 或 `#create new [--dir <目录>]`");
      return;
    }

    // 全新 session：#create new [--dir <目录>]
    if (/^new\b/i.test(trimmed)) {
      const dirMatch = trimmed.match(/(?:--dir|-d)\s+(\S+)/i);
      const dir = dirMatch
        ? expandTilde(dirMatch[1])
        : (callbacks.getCwd?.() ?? homedir());
      await api.sendMarkdown(session, `⏳ 正在创建新实例（工作目录 \`${esc(dir)}\`）...`);
      const result = await spawn({ cwd: dir });
      await replySpawnResult(session, result, `全新 session @ ${dir}`);
      return;
    }

    // 复用现有 session：#create <序号|名称>
    const match = resolveSession(trimmed, sessionManager.listSessions());
    if (!match) {
      await api.sendMarkdown(
        session,
        `Session \`${esc(trimmed)}\` 不存在。用 \`#sessions\` 查看。`
      );
      return;
    }
    // 工作目录优先取 session 头部的真实 cwd（零歧义），缺失时反解项目目录名
    const cwd =
      sessionManager.getSessionCwd(match.path) ??
      sessionManager.unencodeProjectDir(match.projectDir);
    await api.sendMarkdown(
      session,
      `⏳ 正在创建实例（session \`${esc(match.rawName)}\`）...`
    );
    const result = await spawn({ cwd, sessionPath: match.path });
    await replySpawnResult(session, result, match.rawName);
  }

  async function cmdClose(session: QBSession, arg: string): Promise<void> {
    const close = callbacks.closeInstance;
    if (!close) {
      await api.sendMarkdown(session, "❌ 当前实例不支持 #close");
      return;
    }
    const pid = parseInt(arg.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      await api.sendText(session, "用法: `#close <实例ID>`（用 `#instances` 查看在线实例）");
      return;
    }
    const result = await close(pid);
    if (!result.ok) {
      await api.sendMarkdown(session, `❌ 关闭失败: ${esc(result.error ?? "未知错误")}`);
      return;
    }
    if (result.self) {
      // 关闭自己（leader 被 #close）：先回复再退出，剩余实例自动重新选举
      await api.sendMarkdown(
        session,
        `🔄 正在关闭当前实例（${pid}），剩余实例将自动重新选举 leader ...`,
        undefined,
        { claim: false }
      );
      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
          // 忽略
        }
      }, 2000);
      return;
    }
    await api.sendMarkdown(session, `✅ 实例 **${pid}** 已关闭`);
  }

  async function cmdHistory(session: QBSession, arg: string): Promise<void> {
    // 从当前 session 名读取
    const n = parseInt(arg, 10) || DEFAULTS.HISTORY_DEFAULT;

    // 多实例：优先读当前实例的 session 文件（处理这条命令的实例），
    // 避免 listSessions()[0]（全局最近修改）取到其他实例的 session
    const currentFile = callbacks.getCurrentSessionFile?.();
    if (currentFile) {
      const preview = sessionManager.getSessionFilePreview(currentFile, n);
      debug(`#history: file=${currentFile}, count=${n}`);
      await api.sendMarkdown(session, [`## 📝 最近消息 (当前实例)`, "", preview].join("\n"));
      return;
    }

    // 回退：按最近修改的 session 读取
    const sessions = sessionManager.listSessions();
    if (sessions.length === 0) {
      await api.sendText(session, "暂无 session");
      return;
    }

    // 当前活跃的一般是最近修改的 session
    const current = sessions[0];
    debug(`#history: session=${current.name}, count=${n}`);
    const preview = sessionManager.getSessionPreview(current.name, n);
    info(`#history 返回 ${preview.length} 字符, ${(preview.match(/\n/g) ?? []).length + 1} 行`);

    await api.sendMarkdown(
      session,
      [
        `## 📝 最近消息 (${current.name})`,
        "",
        preview,
      ].join("\n")
    );
  }

  async function cmdSettings(session: QBSession, args: string): Promise<void> {
    const settings = callbacks.getSettings();

    if (!args) {
      // 显示当前设置
      const on_ = "✅ 开";
      const off_ = "❌ 关";
      await api.sendMarkdown(session, [
        "## ⚙️ QQ Bot 设置",
        "",
        `| 选项 | 状态 | 说明 |`,
        `|------|------|------|`,
        `| forwardMessages | ${settings.forwardDesktopMessages ? on_ : off_} | 桌面端消息转发到 QQ |`,
        `| forwardTools | ${settings.forwardToolCalls ? on_ : off_} | 工具调用转发到 QQ |`,
        `| lastMessageOnly | ${settings.lastMessageOnly ? on_ : off_} | 只转发整次回复的最后一条 assistant 回复 |`,
        "",
        "**用法：**",
        "- `#settings forwardMessages on` — 开启消息转发",
        "- `#settings forwardMessages off` — 关闭消息转发",
        "- `#settings forwardTools on` — 开启工具转发",
        "- `#settings forwardTools off` — 关闭工具转发",
        "- `#settings lastMessageOnly on` — 只转发最后一条回复（会关闭工具转发）",
        "- `#settings lastMessageOnly off` — 关闭只转发最后一条",
      ].join("\n"));
      return;
    }

    // 解析参数: #settings <key> <on|off>
    const argParts = args.trim().split(/\s+/);
    const key = argParts[0]?.toLowerCase();
    const value = argParts[1]?.toLowerCase();

    if (key === "forwardmessages") {
      if (value === "on") {
        callbacks.updateSettings({ forwardDesktopMessages: true });
        await api.sendMarkdown(session, "✅ **桌面消息转发** 已开启，桌面端输入的内容也会推送到 QQ。");
      } else if (value === "off") {
        callbacks.updateSettings({ forwardDesktopMessages: false });
        await api.sendMarkdown(session, "❌ **桌面消息转发** 已关闭。");
      } else {
        await api.sendText(session, "用法: `#settings forwardMessages on|off`");
      }
      return;
    }

    if (key === "forwardtools") {
      if (value === "on") {
        // 与 lastMessageOnly 互斥：开启工具转发时自动关闭只转发最后一条
        callbacks.updateSettings({ forwardToolCalls: true, lastMessageOnly: false });
        await api.sendMarkdown(session, "✅ **工具调用转发** 已开启，同时 `lastMessageOnly` 已自动关闭。");
      } else if (value === "off") {
        callbacks.updateSettings({ forwardToolCalls: false });
        await api.sendMarkdown(session, "❌ **工具调用转发** 已关闭。");
      } else {
        await api.sendText(session, "用法: `#settings forwardTools on|off`");
      }
      return;
    }

    if (key === "lastmessageonly") {
      if (value === "on") {
        // 与 forwardTools 互锁：开启时强制关闭工具转发
        callbacks.updateSettings({ lastMessageOnly: true, forwardToolCalls: false });
        await api.sendMarkdown(session, "✅ **只转发最后一条回复** 已开启，assistant 整次运行仅发送一条最终回复；`forwardTools` 已自动关闭。");
      } else if (value === "off") {
        callbacks.updateSettings({ lastMessageOnly: false });
        await api.sendMarkdown(session, "❌ **只转发最后一条回复** 已关闭。");
      } else {
        await api.sendText(session, "用法: `#settings lastMessageOnly on|off`");
      }
      return;
    }

    await api.sendMarkdown(
      session,
      `未知设置项 \`${esc(key)}\`。使用 \`#settings\` 查看可用设置。`
    );
  }

  async function cmdTarget(session: QBSession): Promise<void> {
    callbacks.updateSettings({ defaultSession: session });
    callbacks.claimSession?.(session);
    await api.sendMarkdown(
      session,
      `✅ 已将当前会话设为默认转发目标：\`${session.type}\` \`${session.id}\``
    );
  }

  /** 列出所有在线实例（含显示名/角色/认领数） */
  async function cmdInstances(session: QBSession): Promise<void> {
    const list = callbacks.getInstanceList?.() ?? [];
    if (list.length === 0) {
      await api.sendMarkdown(session, "暂无在线实例");
      return;
    }
    const lines = list.map((i) => {
      const roleMark = i.role === "leader" ? "🔑 leader" : "👤 follower";
      const claimed = i.claimedSessions?.length ?? 0;
      const ref = i.name?.trim() ? `（${esc(i.name.trim())}）` : "";
      return `- **${esc(i.id)}**${ref} — ${roleMark}，认领 ${claimed} 个会话`;
    });
    await api.sendMarkdown(
      session,
      [
        "## 📋 在线实例",
        "",
        "用 `#to <实例ID>` 将当前会话切换到指定实例",
        "",
        ...lines,
      ].join("\n")
    );
  }

  /** 切换/定向实例：`#to` 查看绑定，`#to <实例> [内容]` 切换并可选定向发送 */
  async function cmdTo(session: QBSession, arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/);

    if (!parts[0]) {
      // 查看当前绑定
      const claimer = callbacks.getClaimer?.(session);
      if (claimer) {
        const ref = claimer.name?.trim() ? `（pi session: ${esc(claimer.name.trim())}）` : "";
        await api.sendMarkdown(
          session,
          `当前会话由实例 **${esc(claimer.id)}**${ref} 处理。\n用 \`#to <实例ID>\` 切换。`
        );
      } else {
        await api.sendMarkdown(
          session,
          "当前会话未绑定实例（默认由最后活跃实例处理）。用 `#instances` 查看可定向的实例。"
        );
      }
      return;
    }

    // 目标可能含空格（pi session 名参考）：从长到短匹配最长前缀，剩余作为内容
    // 匹配优先级：instanceId 精确 > session 名唯一匹配（在 index.ts resolveInstanceByName 中）
    let entry: InstanceEntry | null = null;
    let content = "";
    for (let i = parts.length; i >= 1; i--) {
      const candidate = parts.slice(0, i).join(" ");
      const e = callbacks.resolveInstance?.(candidate);
      if (e) {
        entry = e;
        content = parts.slice(i).join(" ");
        break;
      }
    }

    if (!entry) {
      await api.sendMarkdown(
        session,
        `实例 \`${esc(parts[0])}\` 不存在或离线。用 \`#instances\` 查看在线实例（instanceId）。`
      );
      return;
    }

    const ok = callbacks.rerouteTo?.(entry.id, session);
    if (!ok) {
      await api.sendMarkdown(session, "❌ 切换失败：IPC 未连接或实例不可用，请稍后重试。");
      return;
    }

    const displayName = entry.id + (entry.name?.trim() ? `（${esc(entry.name.trim())}）` : "");
    if (content) {
      callbacks.injectTo?.(entry.id, session, content);
      // 确认回复不参与会话认领（claim 已由 reroute 切到目标实例）
      await api.sendMarkdown(
        session,
        `✅ 已切换到实例 **${esc(displayName)}**，你的消息已送达：\`${esc(content.slice(0, 50))}\``,
        undefined,
        { claim: false }
      );
    } else {
      // 确认回复不参与会话认领（claim 已由 reroute 切到目标实例）
      await api.sendMarkdown(
        session,
        `✅ 当前会话已切换到实例 **${esc(displayName)}**，之后的回复将路由到该实例。`,
        undefined,
        { claim: false }
      );
    }
  }

  return { tryHandle };
}

export type CommandHandler = ReturnType<typeof createCommandHandler>;
