import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS, DEFAULTS } from "./constants.js";

const LOG_FILE = PATHS.LOG;
const MAX_SIZE = DEFAULTS.LOG_MAX_SIZE;

let _logBuffer: string[] = [];
const MAX_BUFFER = DEFAULTS.LOG_MAX_BUFFER;
let _permsEnsured = false;

/** 确保日志目录与文件权限收紧（目录 0700、文件 0600），避免对话片段泄露给同机其他用户 */
function ensurePerms(): void {
  if (_permsEnsured) return;
  _permsEnsured = true;
  try {
    const dir = dirname(LOG_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      chmodSync(dir, 0o700);
    }
    if (existsSync(LOG_FILE)) {
      chmodSync(LOG_FILE, 0o600);
    }
  } catch {
    // 忽略
  }
}

function ensureLogDir(): void {
  const dir = dirname(LOG_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function rotateIfNeeded(): void {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_SIZE) {
      const marker =
        `[${timestamp()}] [INFO] 日志已达 ${Math.round(MAX_SIZE / 1024 / 1024)}MB，` +
        `已循环覆盖（旧日志已丢弃）\n`;
      writeFileSync(LOG_FILE, marker, { encoding: "utf-8", mode: 0o600 }); // 截断清空并以标记作为新文件首行
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
    ensurePerms();
    ensureLogDir();
    rotateIfNeeded();
    // 首次创建日志文件时以 0600 创建；已存在则保持原权限
    if (!existsSync(LOG_FILE)) {
      writeFileSync(LOG_FILE, line + "\n", { encoding: "utf-8", mode: 0o600 });
    } else {
      appendFileSync(LOG_FILE, line + "\n", "utf-8");
    }
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
    const all = readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
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
    writeFileSync(LOG_FILE, "", { encoding: "utf-8", mode: 0o600 }); // 真正清空文件（append 空串无法截断原有内容）
  } catch {
    // 忽略
  }
}
