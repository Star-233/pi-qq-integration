import type { AuthManager } from "./types.js";
export type { AuthManager } from "./types.js";
/**
 * QQ Bot Access Token 管理器。
 * 负责获取和自动刷新 token。
 */
export declare function createAuthManager(appId: string, appSecret: string): AuthManager;
