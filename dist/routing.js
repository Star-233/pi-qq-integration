/** ref_idx 精确路由映射有效期：与被动消息有效期一致（60 分钟） */
export const REF_IDX_TTL_MS = 60 * 60 * 1000;
/** 从引用消息内容中提取实例署名（【xxx】前缀，可带引用块前缀），用于兜底路由 */
export function extractBracketName(content) {
    const m = content.match(/^(?:>\s*)?【([^】]+)】/);
    return m ? m[1] : null;
}
/**
 * 解析引用消息应路由到的实例 id：ref_idx 精确映射优先，署名（instanceId）匹配兜底。
 * - ref_idx 命中且未过期 → 直接返回映射的实例 id
 * - 署名兜底：被引用消息确为机器人所发（字段存在时）且恰好一个实例 id 匹配才路由
 */
export function resolveRouteInstance(qqMsg, refIdxMap, instances) {
    if (qqMsg.refMsgIdx) {
        const hit = refIdxMap.get(qqMsg.refMsgIdx);
        if (hit) {
            if (Date.now() - hit.ts <= REF_IDX_TTL_MS)
                return hit.instanceId;
            refIdxMap.delete(qqMsg.refMsgIdx);
        }
    }
    if (qqMsg.refMsgContent) {
        if (qqMsg.refMsgFromBot === false)
            return null;
        const signed = extractBracketName(qqMsg.refMsgContent);
        if (signed) {
            // 署名可能是 session名-PID 格式：精确匹配 id，或按 PID 后缀匹配
            const matches = Object.values(instances).filter((i) => i.id === signed || signed.endsWith(`-${i.id}`));
            return matches.length === 1 ? matches[0].id : null;
        }
    }
    return null;
}
/** 解析 #to 目标：instanceId 精确匹配优先，pi session 名（参考）唯一匹配兜底 */
export function resolveInstanceByName(target, instances) {
    const byId = instances[target];
    if (byId)
        return byId;
    const matches = Object.values(instances).filter((i) => i.name === target);
    return matches.length === 1 ? matches[0] : null;
}
