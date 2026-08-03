import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isValidSession,
	isValidSessionKey,
	sanitizeDisplayName,
	SESSION_ID_RE,
} from "../dist/validation.js";

test("isValidSession: 合法 c2c/group/channel 会话", () => {
	assert.equal(isValidSession({ type: "c2c", id: "abc123" }), true);
	assert.equal(isValidSession({ type: "group", id: "ABC_123-xyz" }), true);
	assert.equal(isValidSession({ type: "channel", id: "a1" }), true);
	// 可选字段为字符串时合法
	assert.equal(isValidSession({ type: "c2c", id: "abc", name: "张三", userId: "u1", msgId: "m1", eventId: "e1" }), true);
});

test("isValidSession: 非法会话", () => {
	assert.equal(isValidSession(null), false);
	assert.equal(isValidSession(undefined), false);
	assert.equal(isValidSession("c2c:abc"), false);
	assert.equal(isValidSession({}), false);
	assert.equal(isValidSession({ type: "dm", id: "abc" }), false); // 未知类型
	assert.equal(isValidSession({ type: "c2c" }), false); // 缺 id
	assert.equal(isValidSession({ type: "c2c", id: "" }), false);
	assert.equal(isValidSession({ type: "c2c", id: "ab cd" }), false); // 非法字符
	assert.equal(isValidSession({ type: "c2c", id: "a".repeat(65) }), false); // 超长
	assert.equal(isValidSession({ type: "c2c", id: "abc", name: 123 }), false); // 字段类型错
	assert.equal(isValidSession({ type: "c2c", id: "abc", msgId: {} }), false);
	assert.equal(isValidSession({ type: "c2c", id: "abc", extra: "x" }), true); // 额外字段忽略
});

test("isValidSessionKey: 格式校验", () => {
	assert.equal(isValidSessionKey("c2c:abc123"), true);
	assert.equal(isValidSessionKey("group:ABC_123-xyz"), true);
	assert.equal(isValidSessionKey("channel:a1"), true);
	assert.equal(isValidSessionKey(":abc"), false);
	assert.equal(isValidSessionKey("abc"), false); // 无冒号
	assert.equal(isValidSessionKey("c2c:"), false); // 空 id
	assert.equal(isValidSessionKey("dm:abc"), false); // 未知类型
	assert.equal(isValidSessionKey("c2c:ab cd"), false);
	assert.equal(isValidSessionKey("c2c:abc:def"), false); // id 含冒号
});

test("sanitizeDisplayName: 清洗控制字符/trim/限长", () => {
	assert.equal(sanitizeDisplayName(undefined), "");
	assert.equal(sanitizeDisplayName(""), "");
	assert.equal(sanitizeDisplayName("  hello  "), "hello");
	assert.equal(sanitizeDisplayName("a\nb\u0000c\u001fd"), "abcd");
	assert.equal(sanitizeDisplayName("\u007fDEL"), "DEL");
	assert.equal(sanitizeDisplayName("x".repeat(100)).length, 64);
	assert.equal(sanitizeDisplayName("正常名字"), "正常名字");
});

test("SESSION_ID_RE 边界", () => {
	assert.equal(SESSION_ID_RE.test("a"), true);
	assert.equal(SESSION_ID_RE.test("a".repeat(64)), true);
	assert.equal(SESSION_ID_RE.test("a".repeat(65)), false);
	assert.equal(SESSION_ID_RE.test("a-b_c.1"), false); // 点号不允许
	assert.equal(SESSION_ID_RE.test(""), false);
});
