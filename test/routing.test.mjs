import { test } from "node:test";
import assert from "node:assert/strict";
import {
	extractBracketName,
	resolveRouteInstance,
	resolveInstanceByName,
	REF_IDX_TTL_MS,
} from "../dist/routing.js";

const instances = {
	"host-A-111": { id: "host-A-111", pid: 111, role: "leader", name: "项目A 14:32", claimedSessions: [] },
	"host-B-222": { id: "host-B-222", pid: 222, role: "follower", name: "项目B 09:15", claimedSessions: [] },
	"host-C-333": { id: "host-C-333", pid: 333, role: "follower", name: "项目A 14:32", claimedSessions: [] }, // session 名重复
};

test("extractBracketName: 提取【】前缀", () => {
	assert.equal(extractBracketName("【host-A-111】你好"), "host-A-111");
	// 引用块格式：> 【id】 后接换行正文
	assert.equal(extractBracketName("> 【host-A-111】\n内容"), "host-A-111");
	assert.equal(extractBracketName(">【host-A-111】\n内容"), "host-A-111");
	assert.equal(extractBracketName(">  【host-A-111】内容"), "host-A-111");
	assert.equal(extractBracketName("【host B】x"), "host B");
	assert.equal(extractBracketName("无前缀的消息"), null);
	assert.equal(extractBracketName(""), null);
	assert.equal(extractBracketName("> 无前缀的消息"), null);
	assert.equal(extractBracketName("【】"), null); // 空括号不匹配
});

test("resolveRouteInstance: ref_idx 精确映射优先", () => {
	const refMap = new Map([["REFIDX_aaa", { instanceId: "host-B-222", ts: Date.now() }]]);
	// 精确映射命中（即使署名指向别的实例）
	assert.equal(
		resolveRouteInstance({ refMsgIdx: "REFIDX_aaa", refMsgContent: "【host-A-111】回复" }, refMap, instances),
		"host-B-222"
	);
	// ref_idx 不存在 → 落署名兜底
	assert.equal(
		resolveRouteInstance({ refMsgContent: "【host-B-222】回复" }, new Map(), instances),
		"host-B-222"
	);
});

test("resolveRouteInstance: ref_idx 过期条目被清理", () => {
	const refMap = new Map([["REFIDX_old", { instanceId: "host-B-222", ts: Date.now() - REF_IDX_TTL_MS - 1000 }]]);
	assert.equal(
		resolveRouteInstance({ refMsgIdx: "REFIDX_old" }, refMap, instances),
		null
	);
	assert.equal(refMap.has("REFIDX_old"), false); // 过期条目已删除
});

test("resolveRouteInstance: 署名兜底匹配 instanceId", () => {
	assert.equal(
		resolveRouteInstance({ refMsgContent: "【host-C-333】回复" }, new Map(), instances),
		"host-C-333"
	);
	// 引用块格式署名同样可兜底
	assert.equal(
		resolveRouteInstance({ refMsgContent: "> 【host-B-222】\n回复内容" }, new Map(), instances),
		"host-B-222"
	);
	// session名-PID 格式署名（decorate 新格式）：按 PID 后缀匹配
	assert.equal(
		resolveRouteInstance({ refMsgContent: "> 【项目A-host-B-222】\n回复" }, new Map(), instances),
		"host-B-222"
	);
	// 不存在该 id → 不路由
	assert.equal(
		resolveRouteInstance({ refMsgContent: "【host-X】回复" }, new Map(), instances),
		null
	);
});

test("resolveRouteInstance: PID 实例的署名兜底（session名-PID）", () => {
	const pidInstances = {
		"3863": { id: "3863", pid: 3863, role: "leader", name: "项目A", claimedSessions: [] },
		"2178": { id: "2178", pid: 2178, role: "follower", name: "项目B", claimedSessions: [] },
	};
	// 署名 【项目A-3863】 → 匹配 PID 3863
	assert.equal(
		resolveRouteInstance({ refMsgContent: "> 【项目A-3863】\n回复" }, new Map(), pidInstances),
		"3863"
	);
	// 未命名 session 时署名 【3863】 → 精确匹配
	assert.equal(
		resolveRouteInstance({ refMsgContent: "> 【2178】\n回复" }, new Map(), pidInstances),
		"2178"
	);
	// session 名含短横线也不误匹配（后缀是 PID）
	assert.equal(
		resolveRouteInstance({ refMsgContent: "> 【项目-B-3863】\n回复" }, new Map(), pidInstances),
		"3863"
	);
	// 不存在的 PID 后缀 → 不路由
	assert.equal(
		resolveRouteInstance({ refMsgContent: "> 【项目A-9999】\n回复" }, new Map(), pidInstances),
		null
	);
});

test("resolveRouteInstance: refMsgFromBot=false 拒绝兜底", () => {
	assert.equal(
		resolveRouteInstance({ refMsgContent: "【host-B-222】回复", refMsgFromBot: false }, new Map(), instances),
		null
	);
	// 字段缺失（undefined）仍允许兜底
	assert.equal(
		resolveRouteInstance({ refMsgContent: "【host-B-222】回复", refMsgFromBot: undefined }, new Map(), instances),
		"host-B-222"
	);
	// refMsgFromBot=false 时精确映射仍生效（防冒充的是兜底路径）
	const refMap = new Map([["REFIDX_zzz", { instanceId: "host-B-222", ts: Date.now() }]]);
	assert.equal(
		resolveRouteInstance({ refMsgIdx: "REFIDX_zzz", refMsgContent: "【host-X】", refMsgFromBot: false }, refMap, instances),
		"host-B-222"
	);
});

test("resolveRouteInstance: 无引用信息 → null", () => {
	assert.equal(resolveRouteInstance({}, new Map(), instances), null);
	assert.equal(resolveRouteInstance({ refMsgIdx: "", refMsgContent: "" }, new Map(), instances), null);
});

test("resolveInstanceByName: instanceId 精确优先", () => {
	assert.equal(resolveInstanceByName("host-B-222", instances).id, "host-B-222");
});

test("resolveInstanceByName: session 名唯一匹配", () => {
	assert.equal(resolveInstanceByName("项目B 09:15", instances).id, "host-B-222");
});

test("resolveInstanceByName: session 名重复 → null（不路由）", () => {
	assert.equal(resolveInstanceByName("项目A 14:32", instances), null);
});

test("resolveInstanceByName: 不存在 → null", () => {
	assert.equal(resolveInstanceByName("xxx", instances), null);
	assert.equal(resolveInstanceByName("", instances), null);
});

test("resolveInstanceByName: instanceId 优先于同名 session 名", () => {
	// 某实例 id 恰与另一实例的 name 相同 → id 精确匹配优先
	const inst2 = {
		"proj-1": { id: "proj-1", pid: 1, role: "follower", name: "x", claimedSessions: [] },
		"other-2": { id: "other-2", pid: 2, role: "follower", name: "proj-1", claimedSessions: [] },
	};
	assert.equal(resolveInstanceByName("proj-1", inst2).id, "proj-1");
});
