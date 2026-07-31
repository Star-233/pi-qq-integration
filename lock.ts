import { writeFileSync, readFileSync, unlinkSync, existsSync, openSync, closeSync, chmodSync } from "node:fs";
import { type LockFile, type LockManager, type LockDiagnostics } from "./types.js";
import { PATHS } from "./constants.js";

const DEFAULT_LOCK_PATH = PATHS.LOCK;

/**
 * 基于文件的互斥锁。
 * 用于多 pi 实例场景下确保只有一个实例连接 QQ Bot WebSocket。
 *
 * acquire() 使用 O_EXCL 原子创建锁文件，消除 TOCTOU 竞态：
 *   - 无锁 → 原子创建，成为主人
 *   - 有锁且 PID 存活 → 获取失败，跳过
 *   - 有锁但 PID 死亡 → 删除旧锁后原子创建，接管锁
 */
export function createLockManager(lockPath?: string): LockManager {
	const path = lockPath ?? DEFAULT_LOCK_PATH;
	let _isOwner = false;
	let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	function pidAlive(pid: number): boolean {
		try {
			return process.kill(pid, 0);
		} catch {
			return false;
		}
	}

	function readLock(): LockFile | null {
		try {
			if (!existsSync(path)) return null;
			const raw = readFileSync(path, "utf-8");
			return JSON.parse(raw) as LockFile;
		} catch {
			return null;
		}
	}

	function writeLock(): void {
		const data: LockFile = {
			pid: process.pid,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};
		writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
	}

	/** 使用 O_EXCL 原子创建锁文件 — 如果文件已存在则抛出 EEXIST */
	function tryExclusiveLock(): boolean {
		const data: LockFile = {
			pid: process.pid,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};
		try {
			const fd = openSync(path, "wx", 0o600); // O_WRONLY | O_CREAT | O_EXCL
			writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
			closeSync(fd);
			try {
				chmodSync(path, 0o600);
			} catch {
				// 忽略
			}
			return true;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
			// 其他错误（权限等）也视为失败
			return false;
		}
	}

	async function acquire(): Promise<boolean> {
		// ① 尝试原子创建
		if (tryExclusiveLock()) {
			_isOwner = true;
			return true;
		}

		// ② 锁已存在，读取并判断
		const existing = readLock();

		if (!existing) {
			// 创建和读取之间锁被删除了，再试一次
			if (tryExclusiveLock()) {
				_isOwner = true;
				return true;
			}
			_isOwner = false;
			return false;
		}

		if (existing.pid === process.pid) {
			// 自己已持有锁（可能从 crash 恢复）
			writeLock();
			_isOwner = true;
			return true;
		}

		if (!pidAlive(existing.pid)) {
			// 持有者已死，删除旧锁后原子创建
			try {
				unlinkSync(path);
			} catch {
				// 可能已被其他进程删除
			}
			if (tryExclusiveLock()) {
				_isOwner = true;
				return true;
			}
			// 被其他进程抢先创建了
			_isOwner = false;
			return false;
		}

		// 持有者还活着
		_isOwner = false;
		return false;
	}

	async function release(): Promise<void> {
		if (!_isOwner) return;
		_isOwner = false;
		stopHeartbeat();
		try {
			if (existsSync(path)) {
				const lock = readLock();
				if (lock?.pid === process.pid) {
					unlinkSync(path);
				}
			}
		} catch {
			// 忽略删除失败
		}
	}

	async function heartbeat(): Promise<void> {
		if (!_isOwner) return;
		try {
			writeLock();
		} catch {
			_isOwner = false;
		}
	}

	function isOwner(): boolean {
		return _isOwner;
	}

	function startHeartbeat(intervalMs: number): void {
		stopHeartbeat();
		_heartbeatTimer = setInterval(() => {
			heartbeat().catch(() => {});
		}, intervalMs);
	}

	function stopHeartbeat(): void {
		if (_heartbeatTimer) {
			clearInterval(_heartbeatTimer);
			_heartbeatTimer = null;
		}
	}

	function getDiagnostics(): LockDiagnostics {
		const lock = readLock();
		return {
			isOwner: _isOwner,
			lockPath: path,
			lockExists: existsSync(path),
			currentPid: lock?.pid ?? null,
			heartbeatActive: _heartbeatTimer !== null,
		};
	}

	return { acquire, release, heartbeat, isOwner, startHeartbeat, stopHeartbeat, getDiagnostics };
}
