import type { InstanceEntry } from "./types.js";
/**
 * 多实例引用消息路由的纯函数（无状态、无 IO）。
 * refIdxMap 与 instances 由调用方注入（index.ts 传入 leader 持有的 _refIdxMap 与 registry），
 * 便于独立单测。
 */
/** 引用路由输入的最小形状（QQMessage 的子集） */
export interface QuoteRouteInput {
    refMsgIdx?: string;
    refMsgContent?: string;
    refMsgFromBot?: boolean;
}
/** ref_idx → 来源实例的映射条目 */
export interface RefIdxEntry {
    instanceId: string;
    ts: number;
}
export type RefIdxMap = Map<string, RefIdxEntry>;
/** ref_idx 精确路由映射有效期：与被动消息有效期一致（60 分钟） */
export declare const REF_IDX_TTL_MS: number;
/** 从引用消息内容中提取实例署名（【xxx】前缀，可带引用块前缀），用于兜底路由 */
export declare function extractBracketName(content: string): string | null;
/**
 * 解析引用消息应路由到的实例 id：ref_idx 精确映射优先，署名（instanceId）匹配兜底。
 * - ref_idx 命中且未过期 → 直接返回映射的实例 id
 * - 署名兜底：被引用消息确为机器人所发（字段存在时）且恰好一个实例 id 匹配才路由
 */
export declare function resolveRouteInstance(qqMsg: QuoteRouteInput, refIdxMap: RefIdxMap, instances: Record<string, InstanceEntry>): string | null;
/** 解析 #to 目标：instanceId 精确匹配优先，pi session 名（参考）唯一匹配兜底 */
export declare function resolveInstanceByName(target: string, instances: Record<string, InstanceEntry>): InstanceEntry | null;
