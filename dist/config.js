import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { DEFAULT_QQ_SETTINGS } from "./types.js";
const DEFAULT_CONFIG_PATH = `${homedir()}/.pi/agent/qq-integration-config.json`;
let _config = null;
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
            return {
                forwardDesktopMessages: parsed.settings.forwardDesktopMessages ?? DEFAULT_QQ_SETTINGS.forwardDesktopMessages,
                forwardToolCalls: parsed.settings.forwardToolCalls ?? DEFAULT_QQ_SETTINGS.forwardToolCalls,
                lastMessageOnly: parsed.settings.lastMessageOnly ?? DEFAULT_QQ_SETTINGS.lastMessageOnly,
                defaultSession: parsed.settings.defaultSession ?? DEFAULT_QQ_SETTINGS.defaultSession,
            };
        }
    }
    catch {
        // 忽略读取错误
    }
    return { ...DEFAULT_QQ_SETTINGS };
}
/** 将转发设置保存到配置文件 */
export function saveSettings(settings) {
    const path = DEFAULT_CONFIG_PATH;
    let config = {};
    try {
        if (existsSync(path)) {
            const raw = readFileSync(path, "utf-8");
            config = JSON.parse(raw);
        }
    }
    catch {
        // 忽略
    }
    config.settings = settings;
    writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}
export function clearConfigCache() {
    _config = null;
}
