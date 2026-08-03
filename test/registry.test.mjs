import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";import { tmpdir } from "node:os";
import { join } from "node:path";

// registry.ts 的路径在模块加载时固定（PATHS.REGISTRY），
// 必须先设置环境变量再动态 import，且每个测试文件是独立进程，互不影响。
const dir = mkdtempSync(join(tmpdir(), "qq-registry-test-"));
process.env.QQ_INTEGRATION_DATA_DIR = dir;
// registry 写入需要 <DATA_DIR>/qq-integration 子目录（PATHS.REGISTRY 的父目录）
mkdirSync(join(dir, "qq-integration"), { recursive: true });

const {
	readRegistry,
	writeRegistry,
	upsertInstance,
	removeInstance,
	setClaim,
	findClaimer,
	setLeader,
	clearLeader,
	getLeaderSock,
	touchInstance,
	pruneDead,
} = await import("../dist/registry.js");

const instA = { id: "inst-a", pid: process.pid, role: "leader", name: "A", startedAt: 0, heartbeatAt: 0, claimedSessions: [] };
const instB = { id: "inst-b", pid: process.pid, role: "follower", name: "B", startedAt: 0, heartbeatAt: 0, claimedSessions: [] };

beforeEach(() => {
	writeRegistry({ leader: null, instances: {} });
});

test("readRegistry: 文件不存在返回空 registry", () => {
	const reg = readRegistry();
	assert.equal(reg.leader, null);
	assert.deepEqual(reg.instances, {});
});

test("upsertInstance: 创建与更新", () => {
	upsertInstance({ ...instA });
	let reg = readRegistry();
	assert.equal(reg.instances["inst-a"].name, "A");
	// 更新 name，保留已有字段
	upsertInstance({ ...instA, name: "A2" });
	reg = readRegistry();
	assert.equal(reg.instances["inst-a"].name, "A2");
});

test("upsertInstance: follower 重连空认领不覆盖已有认领", () => {
	upsertInstance({ ...instA, claimedSessions: ["c2c:x1"] });
	// follower 重连上报空认领 → 保留已有认领
	upsertInstance({ ...instA, claimedSessions: [] });
	const reg = readRegistry();
	assert.deepEqual(reg.instances["inst-a"].claimedSessions, ["c2c:x1"]);
});

test("setClaim: 唯一所有者语义（清除其他实例认领）", () => {
	upsertInstance({ ...instA, claimedSessions: ["c2c:x1"] });
	upsertInstance({ ...instB });
	setClaim("inst-b", "c2c:x1");
	const reg = readRegistry();
	assert.deepEqual(reg.instances["inst-a"].claimedSessions, []); // 被清除
	assert.deepEqual(reg.instances["inst-b"].claimedSessions, ["c2c:x1"]);
	assert.equal(findClaimer("c2c:x1")?.id, "inst-b");
});

test("setClaim: 无该实例则忽略", () => {
	writeRegistry({ leader: null, instances: {} });
	setClaim("ghost", "c2c:x1");
	assert.equal(readRegistry().instances["ghost"], undefined);
});

test("removeInstance: 删除实例并清理 leader 记录", () => {
	setLeader("inst-a", "/tmp/leader.sock");
	upsertInstance({ ...instA });
	removeInstance("inst-a");
	const reg = readRegistry();
	assert.equal(reg.instances["inst-a"], undefined);
	assert.equal(reg.leader, null);
	assert.equal(reg.leaderSock, undefined);
});

test("setLeader/clearLeader/getLeaderSock", () => {
	upsertInstance({ ...instA });
	setLeader("inst-a", "/tmp/leader.sock");
	let reg = readRegistry();
	assert.equal(reg.leader, "inst-a");
	assert.equal(reg.instances["inst-a"].role, "leader");
	assert.equal(getLeaderSock(), "/tmp/leader.sock");
	clearLeader();
	reg = readRegistry();
	assert.equal(reg.leader, null);
	assert.equal(getLeaderSock(), undefined);
});

test("touchInstance: 更新心跳时间", async () => {
	upsertInstance({ ...instA, heartbeatAt: 0 });
	await new Promise((r) => setTimeout(r, 5));
	touchInstance("inst-a");
	assert.ok(readRegistry().instances["inst-a"].heartbeatAt > 0);
});

test("pruneDead: 清理 PID 不存在的实例", () => {
	upsertInstance({ ...instA, pid: 999999999 }); // 假 PID（已死）
	upsertInstance({ ...instB }); // 本进程 PID（存活）
	setLeader("inst-a", "/tmp/leader.sock");
	pruneDead();
	const reg = readRegistry();
	assert.equal(reg.instances["inst-a"], undefined); // 死实例被清理
	assert.equal(reg.instances["inst-b"].id, "inst-b"); // 存活实例保留
	assert.equal(reg.leader, null); // leader 是死实例 → 清除
});

test("registry 文件权限 0600", () => {
	const regPath = join(dir, "qq-integration", "registry.json");
	upsertInstance({ ...instA });
	assert.equal(existsSync(regPath), true);
	const mode = statSync(regPath).mode & 0o777;
	assert.equal(mode, 0o600);
	// 文件内容可解析且含实例
	const parsed = JSON.parse(readFileSync(regPath, "utf-8"));
	assert.ok(parsed.instances["inst-a"]);
});

test("registry 写坏文件时容错", () => {
	const regPath = join(dir, "qq-integration", "registry.json");
	mkdirSync(join(dir, "qq-integration"), { recursive: true });
	writeFileSync(regPath, "{broken json");
	assert.deepEqual(readRegistry(), { leader: null, instances: {} });
});

test.after(() => {
	rmSync(dir, { recursive: true, force: true });
});
