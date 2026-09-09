import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// aliases.ts 的路径在模块加载时固定（PATHS.ALIASES），
// 必须先设置环境变量再动态 import，且每个测试文件是独立进程，互不影响。
const dir = mkdtempSync(join(tmpdir(), "qq-alias-test-"));
mkdirSync(join(dir, "qq-integration"), { recursive: true });
process.env.QQ_INTEGRATION_DATA_DIR = dir;

const { resolveAlias, listAliases, setAlias, deleteAlias, sanitizeAliasName, OPENID_RE } =
	await import("../dist/aliases.js");

const ALIASES_PATH = join(dir, "qq-integration", "aliases.json");

beforeEach(() => {
	rmSync(ALIASES_PATH, { force: true });
});

test("resolveAlias: 文件不存在时返回 undefined", () => {
	assert.equal(resolveAlias("AbCdEf123456"), undefined);
});

test("setAlias: 完整 openid 新增，resolveAlias 命中", () => {
	const r = setAlias("AbCdEf1234567890abcd", "张三");
	assert.equal(r.ok, true);
	assert.equal(resolveAlias("AbCdEf1234567890abcd"), "张三");
});

test("setAlias: 唯一前缀命中已有条目（更新）", () => {
	setAlias("AbCdEf1234567890abcd", "张三");
	const r = setAlias("AbCdEf1234", "张三丰");
	assert.equal(r.ok, true);
	assert.equal(resolveAlias("AbCdEf1234567890abcd"), "张三丰");
	assert.match(r.message, /更新/);
});

test("setAlias: 前缀命中多条时报错并列出候选", () => {
	setAlias("AbCdEf111111111111", "张三");
	setAlias("AbCdEf222222222222", "张四");
	const r = setAlias("AbCdEf", "测试");
	assert.equal(r.ok, false);
	assert.match(r.message, /命中 2 条/);
});

test("setAlias: 未命中且不是合法 openid 时报错", () => {
	const r = setAlias("short", "张三");
	assert.equal(r.ok, false);
	assert.match(r.message, /不是合法 openid/);
});

test("setAlias: 别名清洗（控制字符去除、32 字截断）", () => {
	const r = setAlias("AbCdEf1234567890abcd", "  张\x00三  ");
	assert.equal(r.ok, true);
	assert.equal(resolveAlias("AbCdEf1234567890abcd"), "张三");

	const long = "x".repeat(40);
	setAlias("BbCdEf1234567890abcd", long);
	assert.equal(resolveAlias("BbCdEf1234567890abcd"), "x".repeat(32));
});

test("setAlias: 空别名报错", () => {
	const r = setAlias("AbCdEf1234567890abcd", "   ");
	assert.equal(r.ok, false);
	assert.match(r.message, /别名为空/);
});

test("deleteAlias: 唯一前缀删除", () => {
	setAlias("AbCdEf1234567890abcd", "张三");
	const r = deleteAlias("AbCdEf12");
	assert.equal(r.ok, true);
	assert.equal(resolveAlias("AbCdEf1234567890abcd"), undefined);
});

test("deleteAlias: 未命中或多条命中时报错", () => {
	const r1 = deleteAlias("Zz9999");
	assert.equal(r1.ok, false);
	assert.match(r1.message, /未找到/);

	setAlias("AbCdEf111111111111", "张三");
	setAlias("AbCdEf222222222222", "张四");
	const r2 = deleteAlias("AbCdEf");
	assert.equal(r2.ok, false);
	assert.match(r2.message, /命中 2 条/);
});

test("listAliases: 全量输出且 openid→别名 映射正确", () => {
	setAlias("AbCdEf1234567890abcd", "zhang");
	setAlias("BbCdEf1234567890abcd", "li");
	setAlias("CbCdEf1234567890abcd", "wang");
	const all = listAliases();
	assert.equal(all.length, 3);
	// ASCII 别名排序跨平台确定
	assert.deepEqual(
		all.map((e) => e.alias),
		["li", "wang", "zhang"],
	);
	for (const e of all) {
		if (e.openid === "AbCdEf1234567890abcd") assert.equal(e.alias, "zhang");
		if (e.openid === "BbCdEf1234567890abcd") assert.equal(e.alias, "li");
		if (e.openid === "CbCdEf1234567890abcd") assert.equal(e.alias, "wang");
	}
});

test("热重载: 外部直接改文件后 resolveAlias 反映新内容", async () => {
	setAlias("AbCdEf1234567890abcd", "张三");
	assert.equal(resolveAlias("AbCdEf1234567890abcd"), "张三");

	// 直接改文件（模拟手动编辑）
	const store = JSON.parse(
		(await import("node:fs")).readFileSync(ALIASES_PATH, "utf8"),
	);
	store.aliases["AbCdEf1234567890abcd"] = "手动改名";
	writeFileSync(ALIASES_PATH, JSON.stringify(store, null, 2));

	assert.equal(resolveAlias("AbCdEf1234567890abcd"), "手动改名");
});

test("脏数据容错: 畸形文件按空表处理", () => {
	writeFileSync(ALIASES_PATH, "{ not valid json !!!");
	assert.equal(resolveAlias("AbCdEf1234567890abcd"), undefined);
	assert.equal(listAliases().length, 0);
});

test("OPENID_RE 形态校验", () => {
	assert.ok(OPENID_RE.test("AbCdEf1234567890"));
	assert.ok(OPENID_RE.test("ABCDEF1234567890abcd-ef01_2345"));
	assert.ok(!OPENID_RE.test("short"));
	assert.ok(!OPENID_RE.test("has space in it"));
	assert.ok(!OPENID_RE.test("包含中文的openid"));
});
