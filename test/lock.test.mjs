import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createLockManager } from "../dist/lock.js";

// 注：lock.ts 按 PID 判断"是否自己持锁"，同进程内两个 manager 不互斥（视为崩溃恢复）。
// 因此"互斥"场景用假锁文件模拟其他进程（不同 PID）持有者。

function tempLockPath() {
	const dir = mkdtempSync(join(tmpdir(), "qq-lock-test-"));
	return { dir, path: join(dir, "test.lock") };
}

function writeFakeLock(path, pid) {
	writeFileSync(path, JSON.stringify({ pid, startedAt: Date.now(), heartbeatAt: Date.now() }));
}

test("lock: 互斥 — 存活持有者的锁不可获取", async () => {
	const { dir, path } = tempLockPath();
	// 生成一个存活子进程模拟"其他实例"（不同 PID 且同用户可 signal）
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	try {
		await new Promise((r) => setTimeout(r, 100)); // 等子进程就绪
		writeFakeLock(path, child.pid);
		const m = createLockManager(path);
		assert.equal(await m.acquire(), false);
		assert.equal(m.isOwner(), false);
	} finally {
		child.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("lock: 接管死亡持有者的锁（PID 不存在）", async () => {
	const { dir, path } = tempLockPath();
	try {
		writeFakeLock(path, 999999999); // 不存在的 PID → 崩溃残留
		const m = createLockManager(path);
		assert.equal(await m.acquire(), true);
		assert.equal(m.isOwner(), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("lock: 同 PID 崩溃恢复", async () => {
	const { dir, path } = tempLockPath();
	try {
		writeFakeLock(path, process.pid); // 锁是自己的 → 恢复持有
		const m = createLockManager(path);
		assert.equal(await m.acquire(), true);
		assert.equal(m.isOwner(), true);
		await m.release();
		assert.equal(m.isOwner(), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("lock: release 只删自己的锁", async () => {
	const { dir, path } = tempLockPath();
	try {
		// 假锁属于"其他实例"（pid 1）→ release 不应删除它
		writeFakeLock(path, 1);
		const m = createLockManager(path);
		await m.release(); // 非持有者 release 是 no-op
		assert.equal(m.isOwner(), false);
		const lock = JSON.parse(readFileSync(path, "utf-8"));
		assert.equal(lock.pid, 1); // 他人锁未被误删
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("lock: 心跳更新锁文件时间戳", async () => {
	const { dir, path } = tempLockPath();
	const m = createLockManager(path);
	try {
		await m.acquire();
		const before = JSON.parse(readFileSync(path, "utf-8")).heartbeatAt;
		m.startHeartbeat(10);
		await new Promise((r) => setTimeout(r, 30));
		const after = JSON.parse(readFileSync(path, "utf-8")).heartbeatAt;
		assert.ok(after >= before);
		assert.equal(m.isOwner(), true);
	} finally {
		// 无论断言成败都清理 interval，避免事件循环挂起
		m.stopHeartbeat();
		await m.release();
		rmSync(dir, { recursive: true, force: true });
	}
});
