import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { type LockFile, type LockManager, type LockDiagnostics } from "./types";

const DEFAULT_LOCK_PATH = "/home/nullsky/.pi/agent/qq-integration.lock";

/**
 * 基于文件的互斥锁。
 * 用于多 pi 实例场景下确保只有一个实例连接 QQ Bot WebSocket。
 *
 * acquire() 检查锁文件:
 *   - 无锁 → 创建锁，成为主人
 *   - 有锁且 PID 存活 → 获取失败，跳过
 *   - 有锁但 PID 死亡 → 接管锁
 */
export function createLockManager(lockPath?: string): LockManager {
  const path = lockPath ?? DEFAULT_LOCK_PATH;
  let _isOwner = false;
  let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function pidAlive(pid: number): boolean {
    try {
      // kill(pid, 0) 仅检查进程是否存在，不发送信号
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
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  }

  async function acquire(): Promise<boolean> {
    const existing = readLock();

    if (!existing) {
      // 无锁，直接获取
      writeLock();
      _isOwner = true;
      return true;
    }

    if (existing.pid === process.pid) {
      // 自己已持有锁（可能从 crash 恢复）
      writeLock();
      _isOwner = true;
      return true;
    }

    if (!pidAlive(existing.pid)) {
      // 持有者已死，接管
      writeLock();
      _isOwner = true;
      return true;
    }

    // 持有者还活着，获取失败
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
      // 写入失败时放弃锁
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
