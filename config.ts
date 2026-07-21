import { readFileSync, existsSync } from "node:fs";
import type { QQBotConfig } from "./types";

const DEFAULT_CONFIG_PATH = "/home/nullsky/.pi/agent/qq-integration-config.json";

let _config: QQBotConfig | null = null;

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

export function clearConfigCache(): void {
  _config = null;
}
