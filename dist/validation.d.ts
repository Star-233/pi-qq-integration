import type { QBSession } from "./types.js";
/**
 * 无状态校验工具（不依赖 pi API / fs / 网络），独立成模块以便单测。
 */
/** session.id 仅允许安全字符（与 api-client 一致） */
export declare const SESSION_ID_RE: RegExp;
/** 校验 QQ 会话对象结构（inject 等 IPC 入站数据） */
export declare function isValidSession(s: unknown): s is QBSession;
/** 校验会话认领 key 格式（c2c|group|channel:id） */
export declare function isValidSessionKey(key: string): boolean;
/** 清洗参考名：去控制字符/换行，限制长度，避免破坏 markdown 展示 */
export declare function sanitizeDisplayName(name: string | undefined): string;
