import { type LockManager } from "./types.js";
/**
 * 基于文件的互斥锁。
 * 用于多 pi 实例场景下确保只有一个实例连接 QQ Bot WebSocket。
 *
 * acquire() 检查锁文件:
 *   - 无锁 → 创建锁，成为主人
 *   - 有锁且 PID 存活 → 获取失败，跳过
 *   - 有锁但 PID 死亡 → 接管锁
 */
export declare function createLockManager(lockPath?: string): LockManager;
