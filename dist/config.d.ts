import type { QQBotConfig, QqSettings } from "./types.js";
export declare function loadConfig(configPath?: string): QQBotConfig;
/** 读取多实例配置（实例 ID 与角色） */
export declare function loadMultiInstanceConfig(): {
    instanceId: string;
    role: "auto" | "leader" | "follower";
};
/** 从配置文件中读取转发设置 */
export declare function loadSettings(): QqSettings;
/**
 * 将转发设置保存到配置文件。
 * 使用原子写入（tmp + rename）避免 truncate 窗口导致配置文件损毁。
 * read-modify-write 仍非跨进程原子，但原子写入消除了读到空文件后覆写的灾难性风险。
 */
export declare function saveSettings(settings: QqSettings): void;
export declare function clearConfigCache(): void;
