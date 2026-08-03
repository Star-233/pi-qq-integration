import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandHandler } from "../dist/command-handler.js";

/** 最小 ApiClient mock：收集发送的消息 */
function mockApi() {
	const sent = [];
	return {
		sent,
		api: {
			sendMarkdown: async (s, md) => { sent.push({ type: "markdown", text: md }); return {}; },
			sendText: async (s, t) => { sent.push({ type: "text", text: t }); return {}; },
			sendMessage: async (s, t) => { sent.push({ type: "message", text: t }); return {}; },
		},
	};
}

/** 最小 SessionManager mock */
function mockSessionManager() {
	return {
		listSessions: () => [],
		formatSessionListPage: ({ page, pageSize }) => ({
			text: page === 1 ? "1. test" : "2. test",
			total: 12,
			totalPages: 2,
			page: Math.min(page, 2),
		}),
		getSessionCwd: () => undefined,
		unencodeProjectDir: (d) => d,
	};
}

function makeHandler(overrides = {}) {
	const { api, sent } = mockApi();
	const calls = { spawnInstance: [], closeInstance: [] };
	const handler = createCommandHandler(api, mockSessionManager(), {
		sendUserMessage: () => {},
		getSettings: () => ({}),
		updateSettings: () => {},
		spawnInstance: async (o) => { calls.spawnInstance.push(o); return { ok: true, pid: 12345 }; },
		closeInstance: async (pid) => { calls.closeInstance.push(pid); return { ok: true }; },
		...overrides,
	});
	return { handler, sent, calls };
}

const session = { type: "c2c", id: "user1" };

test("命令分发：#create 识别为命令并调用 spawnInstance", async () => {
	const { handler, calls } = makeHandler();
	const handled = await handler.tryHandle("#create new", session);
	assert.equal(handled, true);
	assert.equal(calls.spawnInstance.length, 1);
	assert.equal(calls.spawnInstance[0].cwd.length > 0, true);
	assert.equal(calls.spawnInstance[0].sessionPath, undefined);
});

test("#create new --dir <目录> 传递指定目录（~ 展开）", async () => {
	const { handler, calls } = makeHandler();
	await handler.tryHandle("#create new --dir /tmp/qq-test", session);
	assert.equal(calls.spawnInstance.length, 1);
	assert.equal(calls.spawnInstance[0].cwd, "/tmp/qq-test");
});

test("#create new --dir ~/foo 展开为 home 目录", async () => {
	const { handler, calls } = makeHandler();
	await handler.tryHandle("#create new --dir ~/foo", session);
	assert.equal(calls.spawnInstance[0].cwd, `${process.env.HOME}/foo`);
});

test("#close <PID> 调用 closeInstance 并回复成功", async () => {
	const { handler, calls, sent } = makeHandler();
	const handled = await handler.tryHandle("#close 12345", session);
	assert.equal(handled, true);
	assert.deepEqual(calls.closeInstance, [12345]);
	assert.match(sent[0].text, /已关闭/);
});

test("#close 无参数提示用法", async () => {
	const { handler, sent } = makeHandler();
	await handler.tryHandle("#close", session);
	assert.match(sent[0].text, /用法/);
});

test("#close 多 PID：空格分隔逐个关闭并汇总", async () => {
	const { handler, calls, sent } = makeHandler({
		closeInstance: async (pid) => {
			calls.closeInstance.push(pid);
			if (pid === 999) return { ok: false, error: "不在注册表中" };
			return { ok: true };
		},
	});
	await handler.tryHandle("#close 123 999 456", session);
	assert.deepEqual(calls.closeInstance, [123, 999, 456]);
	assert.match(sent[0].text, /✅ 已关闭: 123, 456/);
	assert.match(sent[0].text, /❌ 999: 不在注册表中/);
});

test("#close 多 PID 含自己：其他先关，自己最后提示退出", async () => {
	const { handler, calls, sent } = makeHandler({
		closeInstance: async (pid) => {
			calls.closeInstance.push(pid);
			return pid === 888 ? { ok: true, self: true } : { ok: true };
		},
	});
	await handler.tryHandle("#close 111 888", session);
	assert.deepEqual(calls.closeInstance, [111, 888]);
	assert.match(sent[0].text, /✅ 已关闭: 111/);
	assert.match(sent[0].text, /正在关闭当前实例（888）/);
});

test("#instances 展示认领会话：名字优先、消息摘要 fallback、无认领", async () => {
	const { handler, sent } = makeHandler({
		getInstanceList: () => [
			{
				id: "111",
				pid: 111,
				role: "leader",
				claimedSessions: ["c2c:aaa", "group:bbb"],
				claimedSessionInfo: {
					"c2c:aaa": { name: "小明", lastMsg: "帮我写代码", at: Date.now() - 5 * 60000 },
					"group:bbb": { lastMsg: "这条消息特别特别长，已经远远超过了六十个字符的限制所以只能显示最前面的部分内容，后面更长的内容全部都要被截断掉不能显示出来啦" },
				},
				startedAt: 0,
				heartbeatAt: 0,
			},
			{
				id: "222",
				pid: 222,
				role: "follower",
				claimedSessions: [],
				startedAt: 0,
				heartbeatAt: 0,
			},
		],
	});
	await handler.tryHandle("#instances", session);
	const text = sent[0].text;
	assert.match(text, /\*\*111\*\*.*leader/);
	assert.match(text, /\*\*小明\*\*/); // 名字优先
	assert.match(text, /💬 这条消息特别特别长/); // 无名字用消息摘要
	assert.ok(!text.includes("不能显示出来啦")); // 已截断到 60
	assert.match(text, /5分钟前/); // 相对时间
	assert.match(text, /\(未认领会话\)/); // 无认领实例
});

test("#sessions 默认第 1 页，带页码时传对应页", async () => {
	const { handler, sent } = makeHandler();
	await handler.tryHandle("#sessions", session);
	assert.match(sent[0].text, /第 1\/2 页/);
	await handler.tryHandle("#sessions 2", session);
	assert.match(sent[1].text, /第 2\/2 页/);
});

test("#sessions 页码越界时 clamp 到有效页", async () => {
	const { handler, sent } = makeHandler();
	await handler.tryHandle("#sessions 99", session);
	// mock 共 2 页：页脚应显示 clamp 后的第 2 页，而不是 99
	assert.match(sent[0].text, /第 2\/2 页/);
	assert.ok(!sent[0].text.includes("99"));
});

test("#resume/#new/#clear 已移除并引导使用 #create", async () => {
	const { handler, sent } = makeHandler();
	for (const cmd of ["#resume 1", "#new", "#clear"]) {
		const handled = await handler.tryHandle(cmd, session);
		assert.equal(handled, true);
	}
	assert.match(sent[0].text, /已移除/);
	assert.match(sent[0].text, /#create/);
});
