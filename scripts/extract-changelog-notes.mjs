#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本段落，写入 GITHUB_OUTPUT（供 .github/workflows/release.yml 使用）。
 *
 * 版本来源优先级：
 *   1. INPUT_VERSION（workflow_dispatch 手动触发时输入）
 *   2. GITHUB_REF_NAME（push tag vX.Y.Z 时，自动去掉 v 前缀）
 *
 * 输出：
 *   notes   — 版本段落 markdown（JSON 转义，单行写入 GITHUB_OUTPUT）
 *   version — 纯版本号（如 0.5.1）
 *
 * 本地调试：直接运行 `node scripts/extract-changelog-notes.mjs`（无 GITHUB_OUTPUT 时打印到 stdout）
 */
import { readFileSync, appendFileSync } from "node:fs";

const inputVersion = (process.env.INPUT_VERSION || "").trim();
const refName = process.env.GITHUB_REF_NAME || "";
const version = (inputVersion || refName.replace(/^v/, "")).trim();

if (!version) {
  console.error("无法确定版本号（INPUT_VERSION 与 GITHUB_REF_NAME 均为空）");
  process.exit(1);
}

const content = readFileSync("CHANGELOG.md", "utf8");
const lines = content.split("\n");

// 定位 "## <version>" 段起始行（精确匹配，避免误匹配 "### " 或 "## 0.5.0 前其他内容"）
const startIdx = lines.findIndex((l) => l === `## ${version}`);
if (startIdx < 0) {
  console.error(`CHANGELOG.md 中未找到 "## ${version}" 段落`);
  process.exit(1);
}

// 段结束：下一个二级（## ）或一级（# ）标题，但不含三级（### ）小节标题
let endIdx = lines.length;
for (let i = startIdx + 1; i < lines.length; i++) {
  const l = lines[i];
  if ((l.startsWith("## ") || l.startsWith("# ")) && !l.startsWith("### ")) {
    endIdx = i;
    break;
  }
}

const notes = lines.slice(startIdx, endIdx).join("\n").trim();

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `notes=${JSON.stringify(notes)}\nversion=${JSON.stringify(version)}\n`,
  );
} else {
  // 本地调试模式
  console.log(`version=${version}`);
  console.log("─".repeat(40));
  console.log(notes);
}
