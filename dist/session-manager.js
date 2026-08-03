import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { error as logError } from "./logger.js";
import { PATHS, DEFAULTS } from "./constants.js";
const SESSIONS_DIR = PATHS.SESSIONS;
const _homeUser = userInfo().username;
/**
 * Pi Session 管理器。
 * Pi 的 session 按项目组织:
 *   ~/.pi/agent/sessions/<项目路径>/
 *     └── <时间戳>_<UUID>.jsonl
 *     └── <时间戳>_<UUID>/      (子分支)
 */
function shortProjectName(raw) {
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
    if (last === _homeUser || last.startsWith(".") || last === "home") {
        // 如果最后一段无意义，取前一段
        last = parts[parts.length - 2] ?? last;
    }
    return last;
}
function relativeTime(date) {
    const diff = Date.now() - date.getTime();
    const min = Math.floor(diff / 60000);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    if (day > 0)
        return day + "天前";
    if (hr > 0)
        return hr + "小时前";
    if (min > 0)
        return min + "分钟前";
    return "刚刚";
}
function shortTime(ts) {
    // 2026-07-21T07-03-07-324Z → 07:03
    const match = ts.match(/T(\d{2})-(\d{2})/);
    return match ? match[1] + ":" + match[2] : ts.slice(0, 16);
}
/** 从 pi message 对象中提取文本内容 */
function extractText(msg) {
    const c = msg.content;
    if (typeof c === "string")
        return c;
    if (Array.isArray(c)) {
        return c
            .filter((p) => typeof p === "object" && p !== null)
            .map((p) => String(p.text ?? p.content ?? ""))
            .join("\n");
    }
    return String(msg.text ?? "");
}
export function createSessionManager() {
    /** 项目目录名是否对应当前工作目录（目录名编码：-- + 去掉开头 / 且 /→- + --，如
     *  /home/u/.pi/a → --home-u-.pi-a--） */
    function projectDirMatches(dirName, cwd) {
        const encoded = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
        return dirName === encoded;
    }
    /**
     * 列出所有 pi session。
     * @param cwd 仅列出当前工作目录对应项目下的 session（多实例共享 sessions 目录时，避免混入其他项目）
     */
    function listSessions(cwd) {
        try {
            const projects = readdirSync(SESSIONS_DIR, { withFileTypes: true });
            const sessions = [];
            for (const project of projects) {
                if (!project.isDirectory())
                    continue;
                // 只显示当前目录对应的项目
                if (cwd && !projectDirMatches(project.name, cwd))
                    continue;
                const projectPath = join(SESSIONS_DIR, project.name);
                const items = readdirSync(projectPath, { withFileTypes: true });
                for (const item of items) {
                    if (!item.isFile() || !item.name.endsWith(".jsonl"))
                        continue;
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
        }
        catch (err) {
            logError(`读取 sessions 失败: ${err}`);
            return [];
        }
    }
    /**
     * 解析 session 文件内容，取最后 N 条 user/assistant 对话（供 #history 使用）
     */
    function parseSessionFile(raw, maxMessages) {
        const allEntries = [];
        for (const line of raw.trim().split("\n")) {
            try {
                const parsed = JSON.parse(line);
                // 只处理 message 类型，跳过 custom 等
                if (parsed.type !== "message")
                    continue;
                const msg = parsed.message ?? parsed;
                const role = msg.role ?? "";
                if (role !== "user" && role !== "assistant")
                    continue;
                // 跳过空的 assistant 消息（tool call 占位符）
                if (role === "assistant" && !extractText(msg).trim())
                    continue;
                allEntries.push({ role, text: extractText(msg) });
            }
            catch {
                // 跳过解析失败的行
            }
        }
        // 取最后 N 条 user/assistant 对话
        const recent = allEntries.slice(-maxMessages);
        if (recent.length === 0)
            return "(无可显示的消息)";
        return recent
            .map((e) => {
            const label = e.role === "user" ? "👤" : "🤖";
            const text = e.text.slice(0, DEFAULTS.MSG_PREVIEW_LEN);
            return `${label} ${text}`;
        })
            .join("\n\n");
    }
    /**
     * 获取 session 前 N 条消息（用于 /history）
     */
    function getSessionPreview(sessionName, maxMessages = 10) {
        try {
            const allSessions = listSessions();
            const match = allSessions.find((s) => s.name.includes(sessionName) ||
                s.rawName.includes(sessionName) ||
                s.path.includes(sessionName));
            if (!match)
                return "Session 不存在";
            const raw = readFileSync(match.path, "utf-8");
            return parseSessionFile(raw, maxMessages);
        }
        catch {
            return "(无法读取)";
        }
    }
    /**
     * 按 session 文件路径读取最近 N 条消息（#history 多实例场景：
     * 直接读当前实例的 session 文件，而不是全局按修改时间猜最近 session）
     */
    function getSessionFilePreview(filePath, maxMessages = 10) {
        try {
            const raw = readFileSync(filePath, "utf-8");
            return parseSessionFile(raw, maxMessages);
        }
        catch {
            return "(无法读取)";
        }
    }
    /**
     * 读取 session 文件的自定义名（session_info.name，/rename 设置）与最后一条用户消息。
     * 倒序遍历：最早的 session_info.name 即最新重命名；从尾往前第一条 user 消息即最新提问。
     */
    function getSessionDisplay(filePath) {
        try {
            const raw = readFileSync(filePath, "utf-8");
            const lines = raw.trim().split("\n");
            let customName;
            let lastUserMessage;
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const parsed = JSON.parse(lines[i]);
                    if (!customName && parsed.type === "session_info" && typeof parsed.name === "string" && parsed.name.trim()) {
                        customName = parsed.name.trim();
                    }
                    if (!lastUserMessage && parsed.type === "message") {
                        const msg = parsed.message ?? parsed;
                        if (msg.role === "user") {
                            const text = extractText(msg).trim();
                            if (text)
                                lastUserMessage = text;
                        }
                    }
                    if (customName && lastUserMessage)
                        break;
                }
                catch {
                    // 跳过解析失败的行
                }
            }
            return { customName, lastUserMessage };
        }
        catch {
            return {};
        }
    }
    /**
     * 读取 session 文件头部（session header）里的 cwd 字段。
     * #create 复用 session 时用真实 cwd 作为新实例工作目录，零歧义（不依赖目录名反解）。
     */
    function getSessionCwd(filePath) {
        try {
            const raw = readFileSync(filePath, "utf-8");
            const firstLine = raw.split("\n", 1)[0];
            const header = JSON.parse(firstLine);
            if (header?.type === "session" && typeof header.cwd === "string" && header.cwd) {
                return header.cwd;
            }
            return undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * 项目目录编码反解（兜底方案；优先用 getSessionCwd）。
     * pi 的编码规则：去掉开头 / 或 \，再把 / \ : 替换为 -，外层包 --。
     * 注意普通 '-' 与分隔符 '-' 存在歧义，靠 existsSync 消歧：
     * 从"全分隔"到"合并"逐个尝试，返回第一个真实存在的路径。
     *   --home-nullsky-.pi-agent-extensions-- → /home/nullsky/.pi/agent/extensions
     */
    function unencodeProjectDir(dirName) {
        if (!dirName.startsWith("--") || !dirName.endsWith("--"))
            return dirName;
        const inner = dirName.slice(2, -2);
        const parts = inner.split("-");
        if (parts.length <= 1)
            return `/${inner}`;
        const n = parts.length;
        // mask 的每一位表示对应位置是否为分隔符；从全分隔（最常见）递减到全合并
        for (let mask = (1 << (n - 1)) - 1; mask >= 0; mask--) {
            const segs = [];
            let cur = parts[0];
            for (let i = 1; i < n; i++) {
                if (mask & (1 << (i - 1))) {
                    segs.push(cur);
                    cur = parts[i];
                }
                else {
                    cur += `-${parts[i]}`;
                }
            }
            segs.push(cur);
            const candidate = `/${segs.join("/")}`;
            if (existsSync(candidate))
                return candidate;
        }
        return `/${inner.replace(/-/g, "/")}`;
    }
    /**
     * 格式化 session 列表为 Markdown（展示自定义名优先，否则最后一条用户消息摘要）
     * @param cwd 只显示当前工作目录对应的项目
     * @param currentFile 当前实例活跃的 session 文件路径（匹配时标记 📌 当前）
     */
    function formatSessionList(cwd, currentFile) {
        const sessions = listSessions(cwd);
        if (sessions.length === 0)
            return "暂无 session";
        return sessions
            .slice(0, DEFAULTS.SESSION_LIST_LIMIT)
            .map((s, i) => {
            const ago = relativeTime(s.modifiedAt);
            const isCurrent = !!currentFile && s.path === currentFile;
            const display = getSessionDisplay(s.path);
            const title = display.customName
                ? `**${display.customName}**`
                : display.lastUserMessage
                    ? `💬 ${display.lastUserMessage.slice(0, DEFAULTS.MSG_PREVIEW_LEN)}`
                    : s.rawName;
            const mark = isCurrent ? "📌 " : "";
            const suffix = isCurrent ? "（当前）" : "";
            return `${i + 1}. ${mark}${title} — ${ago}${suffix}`;
        })
            .join("\n");
    }
    /**
     * 分页格式化**全部** session（跨项目，按 mtime 降序）。
     * 序号为全局序号（跨页连续），可直接用于 #create。
     */
    function formatSessionListPage(opts) {
        const sessions = listSessions();
        const total = sessions.length;
        if (total === 0)
            return { text: "暂无 session", total: 0, totalPages: 0 };
        const totalPages = Math.ceil(total / opts.pageSize);
        const page = Math.min(Math.max(1, opts.page), totalPages);
        const start = (page - 1) * opts.pageSize;
        const items = sessions.slice(start, start + opts.pageSize);
        const lines = items.map((s, i) => {
            const idx = start + i + 1;
            const ago = relativeTime(s.modifiedAt);
            const isCurrent = !!opts.currentFile && s.path === opts.currentFile;
            const display = getSessionDisplay(s.path);
            const title = display.customName
                ? `**${display.customName}**`
                : display.lastUserMessage
                    ? `💬 ${display.lastUserMessage.slice(0, DEFAULTS.MSG_PREVIEW_LEN)}`
                    : s.rawName;
            const mark = isCurrent ? "📌 " : "";
            const suffix = isCurrent ? "（当前）" : "";
            return `${idx}. ${mark}${title} — ${ago}${suffix}`;
        });
        return { text: lines.join("\n"), total, totalPages };
    }
    return {
        listSessions,
        getSessionPreview,
        getSessionFilePreview,
        formatSessionList,
        formatSessionListPage,
        getSessionCwd,
        unencodeProjectDir,
    };
}
