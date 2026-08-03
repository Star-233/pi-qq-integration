import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIpcServer, createIpcClient } from "../dist/ipc.js";

const dir = mkdtempSync(join(tmpdir(), "qq-ipc-test-"));
let sockPath = join(dir, "test.sock");
let seq = 0;
function nextSock() {
	seq++;
	sockPath = join(dir, `test-${seq}.sock`);
	return sockPath;
}

const ENTRY_A = { id: "inst-a", pid: process.pid, role: "follower", claimedSessions: [] };

function waitFor(pred, timeoutMs = 3000) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const timer = setInterval(() => {
			if (pred()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - start > timeoutMs) {
				clearInterval(timer);
				reject(new Error("waitFor 超时"));
			}
		}, 10);
	});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("ipc: 连接建立 + register 上报 + 断开通知", async () => {
	const path = nextSock();
	const events = [];
	const server = createIpcServer(path, {
		onRegister: (entry) => events.push(["register", entry.id]),
		onDisconnect: (id) => events.push(["disconnect", id]),
	});
	await server.ready;
	const client = createIpcClient(path, { onConnect: () => events.push(["connect"]) });
	await waitFor(() => events.some((e) => e[0] === "connect"));
	client.send({ type: "register", entry: ENTRY_A });
	await waitFor(() => events.some((e) => e[0] === "register" && e[1] === "inst-a"));
	assert.equal(server.has("inst-a"), true);
	assert.deepEqual(server.followerIds(), ["inst-a"]);

	client.close();
	await waitFor(() => events.some((e) => e[0] === "disconnect"));
	assert.equal(server.has("inst-a"), false);
	server.close();
});

test("ipc: claim/outbound 上报到 leader（附带注册实例 id）", async () => {
	const path = nextSock();
	const events = [];
	const server = createIpcServer(path, {
		onClaim: (key, id) => events.push(["claim", key, id]),
		onOutbound: (msg, id) => events.push(["outbound", msg.content, id]),
	});
	await server.ready;
	const client = createIpcClient(path, {});
	await waitFor(() => client.isConnected());
	client.send({ type: "register", entry: ENTRY_A });
	await waitFor(() => server.has("inst-a"));
	client.send({ type: "claim", sessionKey: "c2c:openid1" });
	client.send({ type: "outbound", target: { type: "c2c", id: "openid1" }, content: "hello" });
	await waitFor(() => events.length >= 2);
	assert.deepEqual(events[0], ["claim", "c2c:openid1", "inst-a"]);
	assert.deepEqual(events[1], ["outbound", "hello", "inst-a"]);
	server.close();
});

test("ipc: server sendTo/broadcast → client 收到 inbound/settings_changed", async () => {
	const path = nextSock();
	const inbox = [];
	const server = createIpcServer(path, {});
	await server.ready;
	const client = createIpcClient(path, {
		onInbound: (msg) => inbox.push(["inbound", msg.session.id, msg.content]),
		onSettingsChanged: (s) => inbox.push(["settings", s.defaultSession?.id]),
	});
	await waitFor(() => client.isConnected());
	client.send({ type: "register", entry: ENTRY_A });
	await waitFor(() => server.has("inst-a"));

	server.sendTo("inst-a", { type: "inbound", session: { type: "c2c", id: "openid2" }, content: "路由消息", fromTag: "QQ" });
	await waitFor(() => inbox.length >= 1);
	assert.deepEqual(inbox[0], ["inbound", "openid2", "路由消息"]);

	server.broadcast({ type: "settings_changed", settings: { defaultSession: { type: "c2c", id: "openid3" } } });
	await waitFor(() => inbox.length >= 2);
	assert.deepEqual(inbox[1], ["settings", "openid3"]);
	server.close();
});

test("ipc: server 关闭 → client onClose", async () => {
	const path = nextSock();
	let closed = false;
	const server = createIpcServer(path, {});
	await server.ready;
	const client = createIpcClient(path, { onClose: () => (closed = true) });
	await waitFor(() => client.isConnected());
	// 必须先注册，server.close() 才会 destroy 该连接（否则 socket 残留导致进程挂起）
	client.send({ type: "register", entry: ENTRY_A });
	await waitFor(() => server.has("inst-a"));
	server.close();
	await waitFor(() => closed);
	assert.equal(client.isConnected(), false);
});

test("ipc: 非法 register（超长 id）→ 连接被断且不触发 onRegister", async () => {
	const path = nextSock();
	const registerCalls = [];
	let clientClosed = false;
	const server = createIpcServer(path, { onRegister: (e) => registerCalls.push(e.id) });
	await server.ready;
	const client = createIpcClient(path, { onClose: () => (clientClosed = true) });
	await waitFor(() => client.isConnected());
	client.send({ type: "register", entry: { id: "x".repeat(200), pid: 1, role: "follower", claimedSessions: [] } });
	await waitFor(() => clientClosed); // 服务端销毁连接
	assert.equal(registerCalls.length, 0);
	assert.equal(server.followerIds().length, 0);
	client.close();
	server.close();
});

test("ipc: 同 id 重连 — 新连接接管，旧连接 close 不误删新连接", async () => {
	const path = nextSock();
	const registerCount = { n: 0 };
	const disconnectEvents = [];
	const server = createIpcServer(path, {
		onRegister: () => registerCount.n++,
		onDisconnect: (id) => disconnectEvents.push(id),
	});
	await server.ready;

	// 旧连接注册
	const c1 = createIpcClient(path, {});
	await waitFor(() => c1.isConnected());
	c1.send({ type: "register", entry: ENTRY_A });
	await waitFor(() => server.has("inst-a"));

	// 新连接同 id 注册 → 旧连接被服务端销毁，新连接接管
	const c2 = createIpcClient(path, {});
	await waitFor(() => c2.isConnected());
	c2.send({ type: "register", entry: ENTRY_A });
	await waitFor(() => registerCount.n === 2);

	// 旧连接 c1 被销毁（服务端 destroy）→ 但 conns 仍是新连接，不应触发 disconnect
	await sleep(150);
	assert.equal(server.has("inst-a"), true);
	assert.equal(disconnectEvents.length, 0);

	// 显式关闭新连接 → 才触发 disconnect
	c2.close();
	await waitFor(() => disconnectEvents.length === 1);
	assert.equal(server.has("inst-a"), false);
	server.close();
});

test.after(() => {
	rmSync(dir, { recursive: true, force: true });
});
