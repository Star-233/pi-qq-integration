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
export declare const OPENID_RE: RegExp;
/** 别名长度上限 */
export declare const ALIAS_MAX_LEN = 32;
/** 查询别名：命中返回别名，未命中返回 undefined */
export declare function resolveAlias(openid: string | undefined): string | undefined;
/** 列出全部映射（按别名、openid 排序，便于展示） */
export declare function listAliases(): {
    openid: string;
    alias: string;
}[];
/** 清洗别名：去除控制字符，限长 */
export declare function sanitizeAliasName(name: string): string;
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
export declare function setAlias(openidOrPrefix: string, rawAlias: string): AliasOpResult;
/** 删除别名：入参为完整 openid 或唯一前缀 */
export declare function deleteAlias(openidOrPrefix: string): AliasOpResult;
