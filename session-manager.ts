import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PiSessionInfo } from "./types";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

/**
 * Pi Session 管理器。
 * Pi 的 session 按项目组织:
 *   ~/.pi/agent/sessions/<项目路径>/
 *     └── <时间戳>_<UUID>.jsonl
 *     └── <时间戳>_<UUID>/      (子分支)
 */
function shortProjectName(raw: string): string {
  // --home-nullsky--.pi-agent-extensions-- → extensions
  // --home-nullsky-- → home
  // --home-nullsky-Workspaces-learn-- → learn
  const path = raw
    .replace(/^--/, "")
    .replace(/--$/, "")
    .replace(/--/g, "/");
  const parts = path.split("/");
  // 取最后一段，跳过 home/用户名 这类常见前缀
  let last = parts[parts.length - 1];
  if (last === "nullsky" || last.startsWith(".") || last === "home") {
    // 如果最后一段无意义，取前一段
    last = parts[parts.length - 2] ?? last;
  }
  return last;
}

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const min = Math.floor(diff / 60000);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return day + "天前";
  if (hr > 0) return hr + "小时前";
  if (min > 0) return min + "分钟前";
  return "刚刚";
}

function shortTime(ts: string): string {
  // 2026-07-21T07-03-07-324Z → 07:03
  const match = ts.match(/T(\d{2})-(\d{2})/);
  return match ? match[1] + ":" + match[2] : ts.slice(0, 16);
}

export function createSessionManager() {
  /**
   * 列出所有 pi session。
   */
  function listSessions(): PiSessionInfo[] {
    try {
      const projects = readdirSync(SESSIONS_DIR, { withFileTypes: true });
      const sessions: PiSessionInfo[] = [];

      for (const project of projects) {
        if (!project.isDirectory()) continue;

        const projectPath = join(SESSIONS_DIR, project.name);
        const items = readdirSync(projectPath, { withFileTypes: true });

        for (const item of items) {
          if (!item.isFile() || !item.name.endsWith(".jsonl")) continue;

          const filePath = join(projectPath, item.name);
          const stat = statSync(filePath);

          // 文件名格式: 2026-07-21T07-03-07-324Z_019f837c-453c-7689-bc7c-987ee5d3aafc.jsonl
          const fileBase = item.name.replace(/\.jsonl$/, "");
          // 项目名格式: --home-nullsky-.pi-agent-extensions-- → extensions
          const shortName = shortProjectName(project.name);
          const sessionTime = shortTime(fileBase);

          sessions.push({
            name: `${shortName} ${sessionTime}`,
            rawName: fileBase,
            projectDir: project.name,
            path: filePath,
            modifiedAt: stat.mtime,
            size: stat.size,
          });
        }
      }

      sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
      return sessions;
    } catch (err) {
      console.error("[QQ Bot] 读取 sessions 失败:", err);
      return [];
    }
  }

  /**
   * 获取 session 前 N 条消息（用于 /history）
   */
  function getSessionPreview(sessionName: string, maxLines: number = 10): string {
    try {
      const allSessions = listSessions();
      const match = allSessions.find(
        (s) =>
          s.name.includes(sessionName) ||
          s.rawName.includes(sessionName) ||
          s.path.includes(sessionName)
      );
      if (!match) return "Session 不存在";

      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const content = readFileSync(match.path, "utf-8");
      const lines = content.trim().split("\n").slice(-maxLines);

      return lines
        .map((line) => {
          try {
            const parsed = JSON.parse(line);
            return `[${parsed.role ?? "?"}] ${(parsed.content ?? parsed.text ?? "").slice(0, 200)}`;
          } catch {
            return line.slice(0, 200);
          }
        })
        .join("\n");
    } catch {
      return "(无法读取)";
    }
  }

  /**
   * 格式化 session 列表为 Markdown
   */
  function formatSessionList(): string {
    const sessions = listSessions();
    if (sessions.length === 0) return "暂无 session";

    return sessions
      .slice(0, 20)
      .map((s, i) => {
        const ago = relativeTime(s.modifiedAt);
        const sizeKB = (s.size / 1024).toFixed(1);
        return `${i + 1}. **${s.name}** — ${ago} (${sizeKB} KB)`;
      })
      .join("\n");
  }

  return { listSessions, getSessionPreview, formatSessionList };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
