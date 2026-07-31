import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { InstanceEntry, QQRegistry } from "./types.js";
import { PATHS } from "./constants.js";

const REGISTRY_PATH = PATHS.REGISTRY;

function pidAlive(pid: number): boolean {
	try {
		return process.kill(pid, 0);
	} catch {
		return false;
	}
}

/** 原子写入：先写临时文件再 rename，避免 truncate 窗口 */
function atomicWrite(filePath: string, data: string): void {
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, data, "utf-8");
	renameSync(tmp, filePath); // rename 在同一文件系统上是原子的
}

export function readRegistry(): QQRegistry {
	try {
		if (!existsSync(REGISTRY_PATH)) return { leader: null, instances: {} };
		const raw = readFileSync(REGISTRY_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Partial<QQRegistry>;
		return {
			leader: parsed.leader ?? null,
			leaderSock: parsed.leaderSock,
			instances: parsed.instances ?? {},
		};
	} catch {
		return { leader: null, instances: {} };
	}
}

export function writeRegistry(reg: QQRegistry): void {
	try {
		atomicWrite(REGISTRY_PATH, JSON.stringify(reg, null, 2));
	} catch {
		// 忽略写入失败
	}
}

export function upsertInstance(entry: InstanceEntry): void {
	const reg = readRegistry();
	const existing = reg.instances[entry.id];
	// follower 重连时 selfEntry 的 claimedSessions 为空，保留已有的认领，避免重连后丢失
	const claimedSessions =
		entry.claimedSessions.length === 0 && existing?.claimedSessions?.length
			? existing.claimedSessions
			: entry.claimedSessions;
	reg.instances[entry.id] = {
		...existing,
		...entry,
		claimedSessions,
		heartbeatAt: Date.now(),
	};
	writeRegistry(reg);
}

export function removeInstance(id: string): void {
	const reg = readRegistry();
	delete reg.instances[id];
	if (reg.leader === id) {
		reg.leader = null;
		reg.leaderSock = undefined;
	}
	writeRegistry(reg);
}

export function setClaim(id: string, sessionKey: string): void {
	const reg = readRegistry();
	// 唯一所有者语义：先清除其他实例对该会话的认领，避免分裂脑
	for (const inst of Object.values(reg.instances)) {
		if (inst.id !== id) {
			const idx = inst.claimedSessions.indexOf(sessionKey);
			if (idx >= 0) inst.claimedSessions.splice(idx, 1);
		}
	}
	const inst = reg.instances[id];
	if (!inst) return;
	if (!inst.claimedSessions.includes(sessionKey)) {
		inst.claimedSessions = [...inst.claimedSessions, sessionKey];
	}
	writeRegistry(reg);
}

export function findClaimer(sessionKey: string): InstanceEntry | null {
	const reg = readRegistry();
	for (const inst of Object.values(reg.instances)) {
		if (inst.claimedSessions.includes(sessionKey)) return inst;
	}
	return null;
}

export function setLeader(id: string, sockPath: string): void {
	const reg = readRegistry();
	reg.leader = id;
	reg.leaderSock = sockPath;
	if (reg.instances[id]) reg.instances[id].role = "leader";
	writeRegistry(reg);
}

export function clearLeader(): void {
	const reg = readRegistry();
	reg.leader = null;
	reg.leaderSock = undefined;
	writeRegistry(reg);
}

export function getLeaderSock(): string | undefined {
	return readRegistry().leaderSock;
}

export function touchInstance(id: string): void {
	const reg = readRegistry();
	const e = reg.instances[id];
	if (e) {
		e.heartbeatAt = Date.now();
		writeRegistry(reg);
	}
}

export function pruneDead(): void {
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
	if (changed) writeRegistry(reg);
}
