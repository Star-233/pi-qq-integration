import type { ClaimedSessionInfo, InstanceEntry, QQRegistry } from "./types.js";
export declare function readRegistry(): QQRegistry;
export declare function writeRegistry(reg: QQRegistry): void;
export declare function upsertInstance(entry: InstanceEntry): void;
export declare function removeInstance(id: string): void;
/**
 * 认领会话（唯一所有者语义）。
 * @param info 会话展示信息（名字/最近消息），写入 claimedSessionInfo 供 #instances 展示
 */
export declare function setClaim(id: string, sessionKey: string, info?: ClaimedSessionInfo): void;
export declare function findClaimer(sessionKey: string): InstanceEntry | null;
export declare function setLeader(id: string, sockPath: string): void;
export declare function clearLeader(): void;
export declare function getLeaderSock(): string | undefined;
export declare function touchInstance(id: string): void;
export declare function pruneDead(): void;
