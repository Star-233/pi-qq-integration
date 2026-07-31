import { type LockManager } from "./types.js";
/**
 * 基于文件的互斥锁。
 * 用于多 pi 实例场景下确保只有一个实例连接 QQ Bot WebSocket。
 *
 * acquire() 使用 O_EXCL 原子创建锁文件，消除 TOCTOU 竞态：
 *   - 无锁 → 原子创建，成为主人
 *   - 有锁且 PID 存活 → 获取失败，跳过
 *   - 有锁但 PID 死亡 → 删除旧锁后原子创建，接管锁
 */
export declare function createLockManager(lockPath?: string): LockManager;
