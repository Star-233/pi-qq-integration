import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import { DEFAULT_QQ_SETTINGS } from "./types.js";
import { PATHS } from "./constants.js";
import { warn } from "./logger.js";
const DEFAULT_CONFIG_PATH = PATHS.CONFIG;
let _config = null;
/** 原子写入：先写临时文件再 rename。临时文件与目标都以 0600 创建，避免 appSecret 泄露给同机其他用户 */
function atomicWrite(filePath, data) {
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, filePath);
    try {
        chmodSync(filePath, 0o600);
    }
    catch {
        // 忽略
    }
}
export function loadConfig(configPath) {
    if (_config)
        return _config;
    const path = configPath ?? DEFAULT_CONFIG_PATH;
    if (!existsSync(path)) {
        throw new Error(`QQ Bot 配置文件不存在: ${path}\n` +
            `请创建该文件，格式:\n` +
            JSON.stringify({ appId: "你的 AppID", appSecret: "你的 AppSecret" }, null, 2));
    }
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.appId || !parsed.appSecret) {
        throw new Error(`QQ Bot 配置文件格式错误，需要包含 appId 和 appSecret 字段`);
    }
    _config = parsed;
    // 收紧配置文件权限：含 appSecret，必须 0600
    try {
        chmodSync(path, 0o600);
    }
    catch {
        // 忽略
    }
    return _config;
}
/** 读取多实例配置（实例 ID 与角色） */
export function loadMultiInstanceConfig() {
    const path = DEFAULT_CONFIG_PATH;
    let parsed = {};
    try {
        if (existsSync(path))
            parsed = JSON.parse(readFileSync(path, "utf-8"));
    }
    catch {
        // 忽略
    }
    const role = parsed.role === "leader" || parsed.role === "follower" ? parsed.role : "auto";
    const instanceId = parsed.instanceId && parsed.instanceId.trim()
        ? parsed.instanceId.trim()
        : `${hostname()}-${process.pid}`;
    return { instanceId, role };
}
/** 从配置文件中读取转发设置 */
export function loadSettings() {
    const path = DEFAULT_CONFIG_PATH;
    if (!existsSync(path))
        return { ...DEFAULT_QQ_SETTINGS };
    try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.settings) {
            const settings = {
                forwardDesktopMessages: parsed.settings.forwardDesktopMessages ?? DEFAULT_QQ_SETTINGS.forwardDesktopMessages,
                forwardToolCalls: parsed.settings.forwardToolCalls ?? DEFAULT_QQ_SETTINGS.forwardToolCalls,
                lastMessageOnly: parsed.settings.lastMessageOnly ?? DEFAULT_QQ_SETTINGS.lastMessageOnly,
                defaultSession: parsed.settings.defaultSession ?? DEFAULT_QQ_SETTINGS.defaultSession,
            };
            // forwardToolCalls 与 lastMessageOnly 互斥：同时为 true 时以 forwardToolCalls 为准，
            // 关闭 lastMessageOnly（与 #settings 命令层行为一致）
            if (settings.forwardToolCalls && settings.lastMessageOnly) {
                settings.lastMessageOnly = false;
                warn("配置中 forwardToolCalls 与 lastMessageOnly 同时开启，已自动关闭 lastMessageOnly");
            }
            return settings;
        }
    }
    catch {
        // 忽略读取错误
    }
    return { ...DEFAULT_QQ_SETTINGS };
}
/**
 * 将转发设置保存到配置文件。
 * 使用原子写入（tmp + rename）避免 truncate 窗口导致配置文件损毁。
 * read-modify-write 仍非跨进程原子，但原子写入消除了读到空文件后覆写的灾难性风险。
 */
export function saveSettings(settings) {
    const path = DEFAULT_CONFIG_PATH;
    let config = {};
    try {
        if (existsSync(path)) {
            const raw = readFileSync(path, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                config = parsed;
            }
        }
    }
    catch {
        // JSON.parse 失败（文件可能被其他进程正在写入）：
        // 不覆盖！保留空 config 会导致 appId/appSecret 丢失。
        // 放弃本次写入以保护配置文件完整性。
        return;
    }
    config.settings = settings;
    try {
        atomicWrite(path, JSON.stringify(config, null, 2));
    }
    catch {
        // 忽略写入失败
    }
}
export function clearConfigCache() {
    _config = null;
}
