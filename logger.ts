import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

const LOG_FILE = "/home/nullsky/.pi/agent/qq-integration.log";
const MAX_SIZE = 5 * 1024 * 1024; // 5MB，超过则清空重写

let _logBuffer: string[] = [];
const MAX_BUFFER = 200; // 内存保留最近 200 条，供 /qq-logs 查看

function ensureLogDir(): void {
  const dir = dirname(LOG_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function rotateIfNeeded(): void {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_SIZE) {
      // 简单处理：超过大小就清空
      appendFileSync(LOG_FILE, `[${timestamp()}] [INFO] 日志文件超过 5MB，已截断\n`);
    }
  } catch {
    // 忽略
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

export function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string): void {
  const line = `[${timestamp()}] [${level}] ${message}`;

  // 写入文件
  try {
    ensureLogDir();
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {
    // 写入文件失败时静默忽略
  }

  // 保留内存缓冲
  _logBuffer.push(line);
  if (_logBuffer.length > MAX_BUFFER) {
    _logBuffer = _logBuffer.slice(-MAX_BUFFER);
  }
}

export function debug(message: string): void {
  log("DEBUG", message);
}

export function info(message: string): void {
  log("INFO", message);
}

export function warn(message: string): void {
  log("WARN", message);
}

export function error(message: string): void {
  log("ERROR", message);
}

/**
 * 读取最近 N 条日志
 */
export function readRecentLines(n: number = 30): string[] {
  // 优先从内存缓冲区读
  if (_logBuffer.length >= n) {
    return _logBuffer.slice(-n);
  }

  // 缓冲区不够再从文件补
  try {
    if (!existsSync(LOG_FILE)) return _logBuffer;
    const all = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    const combined = [..._logBuffer];

    // 从文件尾部找不在缓冲区中的行
    const fileLines = all.slice(-(n + _logBuffer.length));
    for (const line of fileLines) {
      if (!combined.includes(line)) {
        combined.push(line);
      }
    }

    return combined.slice(-n);
  } catch {
    return _logBuffer.slice(-n);
  }
}

/**
 * 获取日志文件路径
 */
export function getLogPath(): string {
  return LOG_FILE;
}

/**
 * 清空日志
 */
export function clearLog(): void {
  _logBuffer = [];
  try {
    appendFileSync(LOG_FILE, "", "utf-8");
  } catch {
    // 忽略
  }
}
