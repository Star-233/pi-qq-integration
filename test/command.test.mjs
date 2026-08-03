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

test("#sessions 默认第 1 页，带页码时传对应页", async () => {
	const { handler, sent } = makeHandler();
	await handler.tryHandle("#sessions", session);
	assert.match(sent[0].text, /第 1\/2 页/);
	await handler.tryHandle("#sessions 2", session);
	assert.match(sent[1].text, /第 2\/2 页/);
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
