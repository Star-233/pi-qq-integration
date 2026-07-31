import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import type { QQBotConfig, QqSettings } from "./types.js";
import { DEFAULT_QQ_SETTINGS } from "./types.js";
import { PATHS } from "./constants.js";

const DEFAULT_CONFIG_PATH = PATHS.CONFIG;

let _config: QQBotConfig | null = null;

/** 原子写入：先写临时文件再 rename */
function atomicWrite(filePath: string, data: string): void {
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, data, "utf-8");
	renameSync(tmp, filePath);
}

export function loadConfig(configPath?: string): QQBotConfig {
	if (_config) return _config;

	const path = configPath ?? DEFAULT_CONFIG_PATH;

	if (!existsSync(path)) {
		throw new Error(
			`QQ Bot 配置文件不存在: ${path}\n` +
				`请创建该文件，格式:\n` +
				JSON.stringify({ appId: "你的 AppID", appSecret: "你的 AppSecret" }, null, 2)
		);
	}

	const raw = readFileSync(path, "utf-8");
	const parsed = JSON.parse(raw) as Partial<QQBotConfig>;

	if (!parsed.appId || !parsed.appSecret) {
		throw new Error(`QQ Bot 配置文件格式错误，需要包含 appId 和 appSecret 字段`);
	}

	_config = parsed as QQBotConfig;
	return _config;
}

/** 读取多实例配置（实例 ID 与角色） */
export function loadMultiInstanceConfig(): { instanceId: string; role: "auto" | "leader" | "follower" } {
	const path = DEFAULT_CONFIG_PATH;
	let parsed: Partial<QQBotConfig> = {};
	try {
		if (existsSync(path)) parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<QQBotConfig>;
	} catch {
		// 忽略
	}
	const role: "auto" | "leader" | "follower" =
		parsed.role === "leader" || parsed.role === "follower" ? parsed.role : "auto";
	const instanceId =
		parsed.instanceId && parsed.instanceId.trim()
			? parsed.instanceId.trim()
			: `${hostname()}-${process.pid}`;
	return { instanceId, role };
}

/** 从配置文件中读取转发设置 */
export function loadSettings(): QqSettings {
	const path = DEFAULT_CONFIG_PATH;
	if (!existsSync(path)) return { ...DEFAULT_QQ_SETTINGS };
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<QQBotConfig>;
		if (parsed.settings) {
			return {
				forwardDesktopMessages:
					parsed.settings.forwardDesktopMessages ?? DEFAULT_QQ_SETTINGS.forwardDesktopMessages,
				forwardToolCalls:
					parsed.settings.forwardToolCalls ?? DEFAULT_QQ_SETTINGS.forwardToolCalls,
				lastMessageOnly:
					parsed.settings.lastMessageOnly ?? DEFAULT_QQ_SETTINGS.lastMessageOnly,
				defaultSession:
					parsed.settings.defaultSession ?? DEFAULT_QQ_SETTINGS.defaultSession,
			};
		}
	} catch {
		// 忽略读取错误
	}
	return { ...DEFAULT_QQ_SETTINGS };
}

/**
 * 将转发设置保存到配置文件。
 * 使用原子写入（tmp + rename）避免 truncate 窗口导致配置文件损毁。
 * read-modify-write 仍非跨进程原子，但原子写入消除了读到空文件后覆写的灾难性风险。
 */
export function saveSettings(settings: QqSettings): void {
	const path = DEFAULT_CONFIG_PATH;
	let config: Record<string, unknown> = {};
	try {
		if (existsSync(path)) {
			const raw = readFileSync(path, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object") {
				config = parsed;
			}
		}
	} catch {
		// JSON.parse 失败（文件可能被其他进程正在写入）：
		// 不覆盖！保留空 config 会导致 appId/appSecret 丢失。
		// 放弃本次写入以保护配置文件完整性。
		return;
	}
	config.settings = settings;
	try {
		atomicWrite(path, JSON.stringify(config, null, 2));
	} catch {
		// 忽略写入失败
	}
}

export function clearConfigCache(): void {
	_config = null;
}
