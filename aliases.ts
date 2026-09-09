import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	statSync,
	existsSync,
} from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "./constants.js";
import { debug, warn } from "./logger.js";

/**
 * openid → 别名映射表（方案 B：人工跨场景身份关联）。
 *
 * QQ 官方平台对同一用户在不同场景（私聊 user_openid / 各群 member_openid）
 * 下发的 openid 互不相同，且官方未提供 unionid 打通。本模块维护一张
 * 人工映射表，把同一自然人的多个 openid 指到同一别名，供消息前缀展示。
 *
 * 文件: PATHS.ALIASES（~/.pi/agent/qq-integration/aliases.json）
 * 带 mtime 热重载：外部直接编辑文件后无需重启即生效。
 */

export interface AliasStore {
	version: 1;
	aliases: Record<string, string>;
}

/** openid 形态约束（QQ openid 为字母数字组合，长度 8~64） */
export const OPENID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 别名长度上限 */
export const ALIAS_MAX_LEN = 32;

/** 映射条目硬上限（防文件膨胀） */
const MAX_ALIASES = 1000;

/** 内存缓存 + mtime 热重载 */
let _cache: Map<string, string> = new Map();
let _cacheMtimeMs = -1;

function aliasesPath(): string {
	return PATHS.ALIASES;
}

function emptyStore(): AliasStore {
	return { version: 1, aliases: {} };
}

/** 从磁盘读取映射文件（不做缓存，供内部与测试使用） */
function readStoreFile(): AliasStore {
	const path = aliasesPath();
	if (!existsSync(path)) return emptyStore();
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!raw || typeof raw !== "object") return emptyStore();
		const o = raw as Record<string, unknown>;
		if (!o.aliases || typeof o.aliases !== "object") return emptyStore();
		const aliases: Record<string, string> = {};
		for (const [k, v] of Object.entries(o.aliases as Record<string, unknown>)) {
			if (typeof k === "string" && typeof v === "string" && k.length > 0) {
				aliases[k] = v;
			}
		}
		return { version: 1, aliases };
	} catch (err) {
		warn(`别名映射文件解析失败（忽略，按空表处理）: ${err}`);
		return emptyStore();
	}
}

function writeStoreFile(store: AliasStore): void {
	const path = aliasesPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
	_cacheMtimeMs = -1; // 强制下次读取时重新加载
}

/** 带缓存的映射表读取：mtime 变化时自动重载（外部编辑文件即时生效） */
function loadAliases(): Map<string, string> {
	const path = aliasesPath();
	let mtimeMs = -1;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		// 文件不存在 → 空表
	}
	if (mtimeMs !== _cacheMtimeMs) {
		_cache = new Map(Object.entries(readStoreFile().aliases));
		_cacheMtimeMs = mtimeMs;
		debug(`别名映射已加载: ${_cache.size} 条`);
	}
	return _cache;
}

/** 查询别名：命中返回别名，未命中返回 undefined */
export function resolveAlias(openid: string | undefined): string | undefined {
	if (!openid) return undefined;
	return loadAliases().get(openid);
}

/** 列出全部映射（按别名、openid 排序，便于展示） */
export function listAliases(): { openid: string; alias: string }[] {
	return [...loadAliases().entries()]
		.map(([openid, alias]) => ({ openid, alias }))
		.sort((a, b) => a.alias.localeCompare(b.alias) || a.openid.localeCompare(b.openid));
}

/** 清洗别名：去除控制字符，限长 */
export function sanitizeAliasName(name: string): string {
	// eslint-disable-next-line no-control-regex
	return name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, ALIAS_MAX_LEN);
}

export interface AliasOpResult {
	ok: boolean;
	message: string;
}

/**
 * 设置别名。
 * 入参支持完整 openid 或已有条目的唯一前缀：
 * - 前缀唯一命中已有 key → 修改该条目
 * - 前缀命中多条 → 报错并列出候选
 * - 未命中任何条目 → 视为完整 openid 校验后新增
 */
export function setAlias(openidOrPrefix: string, rawAlias: string): AliasOpResult {
	const input = openidOrPrefix.trim();
	const alias = sanitizeAliasName(rawAlias);
	if (!input) return { ok: false, message: "缺少 openid" };
	if (!alias) return { ok: false, message: "别名为空（1~32 个字符）" };

	const map = loadAliases();
	const hits = [...map.keys()].filter((k) => k.startsWith(input));
	if (hits.length > 1) {
		const list = hits
			.slice(0, 5)
			.map((k) => `  ${k.slice(0, 16)}… → ${map.get(k)}`)
			.join("\n");
		return {
			ok: false,
			message: `前缀 \`${input}\` 命中 ${hits.length} 条，请用更长的前缀：\n${list}`,
		};
	}
	const key = hits.length === 1 ? hits[0] : input;
	if (!OPENID_RE.test(key)) {
		return {
			ok: false,
			message: `\`${input}\` 不是合法 openid（8~64 位字母数字），也未命中已有条目的前缀`,
		};
	}
	if (map.size >= MAX_ALIASES && !map.has(key)) {
		return { ok: false, message: `映射条目已达上限 ${MAX_ALIASES}，请先清理` };
	}
	const replaced = map.has(key);
	map.set(key, alias);
	writeStoreFile({ version: 1, aliases: Object.fromEntries(map) });
	return {
		ok: true,
		message: `${replaced ? "更新" : "新增"}: ${key.slice(0, 16)}… → ${alias}`,
	};
}

/** 删除别名：入参为完整 openid 或唯一前缀 */
export function deleteAlias(openidOrPrefix: string): AliasOpResult {
	const input = openidOrPrefix.trim();
	if (!input) return { ok: false, message: "缺少 openid" };

	const map = loadAliases();
	const hits = [...map.keys()].filter((k) => k.startsWith(input));
	if (hits.length === 0) {
		return { ok: false, message: `未找到匹配 \`${input}\` 的条目` };
	}
	if (hits.length > 1) {
		const list = hits
			.slice(0, 5)
			.map((k) => `  ${k.slice(0, 16)}… → ${map.get(k)}`)
			.join("\n");
		return {
			ok: false,
			message: `前缀 \`${input}\` 命中 ${hits.length} 条，请用更长的前缀：\n${list}`,
		};
	}
	const key = hits[0];
	const alias = map.get(key)!;
	map.delete(key);
	writeStoreFile({ version: 1, aliases: Object.fromEntries(map) });
	return { ok: true, message: `已删除: ${key.slice(0, 16)}… (原别名 ${alias})` };
}
