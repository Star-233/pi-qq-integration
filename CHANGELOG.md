# Changelog

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
