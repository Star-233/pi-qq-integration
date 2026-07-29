import type { QQBotConfig, QqSettings } from "./types.js";
export declare function loadConfig(configPath?: string): QQBotConfig;
/** 读取多实例配置（实例 ID 与角色） */
export declare function loadMultiInstanceConfig(): {
    instanceId: string;
    role: "auto" | "leader" | "follower";
};
/** 从配置文件中读取转发设置 */
export declare function loadSettings(): QqSettings;
/** 将转发设置保存到配置文件 */
export declare function saveSettings(settings: QqSettings): void;
export declare function clearConfigCache(): void;
