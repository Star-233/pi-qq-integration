import type { QBSession } from "./types.js";

/**
 * 无状态校验工具（不依赖 pi API / fs / 网络），独立成模块以便单测。
 */

/** session.id 仅允许安全字符（与 api-client 一致） */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 校验 QQ 会话对象结构（inject 等 IPC 入站数据） */
export function isValidSession(s: unknown): s is QBSession {
	if (!s || typeof s !== "object") return false;
	const o = s as Record<string, unknown>;
	if (o.type !== "c2c" && o.type !== "group" && o.type !== "channel") return false;
	if (typeof o.id !== "string" || !SESSION_ID_RE.test(o.id)) return false;
	if (o.name !== undefined && typeof o.name !== "string") return false;
	if (o.userId !== undefined && typeof o.userId !== "string") return false;
	if (o.msgId !== undefined && typeof o.msgId !== "string") return false;
	if (o.eventId !== undefined && typeof o.eventId !== "string") return false;
	return true;
}

/** 校验会话认领 key 格式（c2c|group|channel:id） */
export function isValidSessionKey(key: string): boolean {
	const idx = key.indexOf(":");
	if (idx <= 0) return false;
	const type = key.slice(0, idx);
	const id = key.slice(idx + 1);
	return (type === "c2c" || type === "group" || type === "channel") && SESSION_ID_RE.test(id);
}

/** 清洗参考名：去控制字符/换行，限制长度，避免破坏 markdown 展示 */
export function sanitizeDisplayName(name: string | undefined): string {
	if (!name) return "";
	return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
}
