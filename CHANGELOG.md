# Changelog

## 0.2.6

- 修复同一 `msg_id` 多次回复被 QQ 去重的问题：为每个 `msg_id` 维护递增的 `msg_seq`。

## 0.2.5

- 保存 QQ 消息的最新 `msg_id` / `event_id`，桌面端转发时作为被动回复参数带上，解决主动消息无权限/被限制的问题。
- C2C 会话使用 `user_openid` 作为 API 路径参数（符合 QQ Bot 文档）。

## 0.2.4

- 修复桌面端消息内容类型不兼容：pi 桌面用户消息的内容可能是 `TextContent[]` 数组，而不是字符串。
- 桌面端转发统一使用 `extractTextFromContent()` 提取文本，兼容字符串和数组两种格式。

## 0.2.3

- 为桌面端消息转发路径增加详细日志，便于诊断转发未生效的原因。

## 0.2.2

- 新增 `/qq-target` slash 命令，支持手动设置/查看/清除默认 QQ 转发目标。
- 新增 QQ 命令 `#target`，可将当前 QQ 会话设为默认转发目标。
- 桌面端消息转发目标优先级：最近活跃 QQ 会话 → 手动设置的默认目标。
- 完善 README 中桌面端消息转发说明。

## 0.2.1

- 修复桌面端消息转发 Bug：首次 QQ 消息到达前，桌面端消息没有目标会话而被丢弃。
- 新增 `QqSettings.defaultSession`，在收到 QQ 消息时自动记忆会话目标并持久化。
- 桌面端消息转发优先使用 `_lastActiveQqSession`，不存在时回退到 `_settings.defaultSession`。

## 0.2.0

- 重构为符合 pi 官方 package 规范的发布结构。
- 新增 TypeScript 构建流程，发布产物为 `dist/` 下的 `.js` 与 `.d.ts`。
- `main`、`types`、`exports`、`pi.extensions` 均指向 `dist/index.js`。
- 移除本地 `pi-types.d.ts`，改为从 `@earendil-works/pi-coding-agent` 导入类型。
- 添加 `LICENSE`、`CHANGELOG.md` 与 `files` 字段。

## 0.1.14

- 最后一个直接发布 TypeScript 源码的版本。
