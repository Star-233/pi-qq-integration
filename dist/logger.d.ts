export declare function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string): void;
export declare function debug(message: string): void;
export declare function info(message: string): void;
export declare function warn(message: string): void;
export declare function error(message: string): void;
/**
 * 读取最近 N 条日志
 */
export declare function readRecentLines(n?: number): string[];
/**
 * 获取日志文件路径
 */
export declare function getLogPath(): string;
/**
 * 清空日志
 */
export declare function clearLog(): void;
