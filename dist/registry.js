import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { PATHS } from "./constants.js";
const REGISTRY_PATH = PATHS.REGISTRY;
function pidAlive(pid) {
    try {
        return process.kill(pid, 0);
    }
    catch {
        return false;
    }
}
/** 原子写入：先写临时文件再 rename，避免 truncate 窗口。0600 权限，含 PID/socket 路径等敏感信息 */
function atomicWrite(filePath, data) {
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, filePath);
    try {
        chmodSync(filePath, 0o600);
    }
    catch {
        // 忽略
    }
}
export function readRegistry() {
    try {
        if (!existsSync(REGISTRY_PATH))
            return { leader: null, instances: {} };
        const raw = readFileSync(REGISTRY_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        return {
            leader: parsed.leader ?? null,
            leaderSock: parsed.leaderSock,
            instances: parsed.instances ?? {},
        };
    }
    catch {
        return { leader: null, instances: {} };
    }
}
export function writeRegistry(reg) {
    try {
        atomicWrite(REGISTRY_PATH, JSON.stringify(reg, null, 2));
    }
    catch {
        // 忽略写入失败
    }
}
export function upsertInstance(entry) {
    const reg = readRegistry();
    const existing = reg.instances[entry.id];
    // follower 重连时 selfEntry 的 claimedSessions 为空，保留已有的认领，避免重连后丢失
    const claimedSessions = entry.claimedSessions.length === 0 && existing?.claimedSessions?.length
        ? existing.claimedSessions
        : entry.claimedSessions;
    // 重连时同样保留认领展示信息（selfEntry 不携带 claimedSessionInfo）
    const claimedSessionInfo = entry.claimedSessionInfo ?? existing?.claimedSessionInfo;
    reg.instances[entry.id] = {
        ...existing,
        ...entry,
        claimedSessions,
        claimedSessionInfo,
        heartbeatAt: Date.now(),
    };
    writeRegistry(reg);
}
export function removeInstance(id) {
    const reg = readRegistry();
    delete reg.instances[id];
    if (reg.leader === id) {
        reg.leader = null;
        reg.leaderSock = undefined;
    }
    writeRegistry(reg);
}
/**
 * 认领会话（唯一所有者语义）。
 * @param info 会话展示信息（名字/最近消息），写入 claimedSessionInfo 供 #instances 展示
 */
export function setClaim(id, sessionKey, info) {
    const reg = readRegistry();
    // 唯一所有者语义：先清除其他实例对该会话的认领，避免分裂脑
    for (const inst of Object.values(reg.instances)) {
        if (inst.id !== id) {
            const idx = inst.claimedSessions.indexOf(sessionKey);
            if (idx >= 0)
                inst.claimedSessions.splice(idx, 1);
            // 同步清理被夺走的认领展示信息
            if (inst.claimedSessionInfo) {
                delete inst.claimedSessionInfo[sessionKey];
            }
        }
    }
    const inst = reg.instances[id];
    if (!inst)
        return;
    if (!inst.claimedSessions.includes(sessionKey)) {
        inst.claimedSessions = [...inst.claimedSessions, sessionKey];
    }
    if (info) {
        inst.claimedSessionInfo ??= {};
        inst.claimedSessionInfo[sessionKey] = { ...info, at: Date.now() };
    }
    else if (inst.claimedSessionInfo) {
        delete inst.claimedSessionInfo[sessionKey];
    }
    writeRegistry(reg);
}
export function findClaimer(sessionKey) {
    const reg = readRegistry();
    for (const inst of Object.values(reg.instances)) {
        if (inst.claimedSessions.includes(sessionKey))
            return inst;
    }
    return null;
}
export function setLeader(id, sockPath) {
    const reg = readRegistry();
    reg.leader = id;
    reg.leaderSock = sockPath;
    if (reg.instances[id])
        reg.instances[id].role = "leader";
    writeRegistry(reg);
}
export function clearLeader() {
    const reg = readRegistry();
    reg.leader = null;
    reg.leaderSock = undefined;
    writeRegistry(reg);
}
export function getLeaderSock() {
    return readRegistry().leaderSock;
}
export function touchInstance(id) {
    const reg = readRegistry();
    const e = reg.instances[id];
    if (e) {
        e.heartbeatAt = Date.now();
        writeRegistry(reg);
    }
}
export function pruneDead() {
    const reg = readRegistry();
    let changed = false;
    for (const [id, inst] of Object.entries(reg.instances)) {
        if (!pidAlive(inst.pid)) {
            delete reg.instances[id];
            changed = true;
        }
    }
    if (reg.leader && (!reg.instances[reg.leader] || !pidAlive(reg.instances[reg.leader].pid))) {
        reg.leader = null;
        reg.leaderSock = undefined;
        changed = true;
    }
    if (changed)
        writeRegistry(reg);
}
