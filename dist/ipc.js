import { createServer, connect } from "node:net";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function createIpcServer(sockPath, handlers) {
    // Windows 命名管道是临时资源（server 关闭即消失），无需文件系统目录创建/清理；
    // 仅 Unix domain socket 需要 mkdir 目录 + unlink 残留 socket 文件。
    if (process.platform !== "win32") {
        const dir = dirname(sockPath);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        if (existsSync(sockPath)) {
            try {
                unlinkSync(sockPath);
            }
            catch {
                // 忽略
            }
        }
    }
    const conns = new Map();
    const server = createServer((sock) => {
        let buf = "";
        let id = null;
        sock.on("data", (data) => {
            buf += data.toString("utf-8");
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line)
                    continue;
                try {
                    const env = JSON.parse(line);
                    if (env.type === "register") {
                        id = env.entry.id;
                        conns.set(id, sock);
                        handlers.onRegister?.(env.entry);
                    }
                    else if (env.type === "claim" && id) {
                        handlers.onClaim?.(env.sessionKey, id);
                    }
                    else if (env.type === "outbound" && id) {
                        handlers.onOutbound?.(env, id);
                    }
                    else if (env.type === "heartbeat") {
                        // no-op
                    }
                    else if (env.type === "unregister" && id) {
                        conns.delete(id);
                        handlers.onDisconnect?.(id);
                    }
                    else if (env.type === "settings_request" && id) {
                        handlers.onSettingsRequest?.(id);
                    }
                    else if (env.type === "settings_update" && id) {
                        handlers.onSettingsUpdate?.(env.settings, id);
                    }
                }
                catch {
                    // 忽略坏行
                }
            }
        });
        sock.on("close", () => {
            if (id) {
                conns.delete(id);
                handlers.onDisconnect?.(id);
            }
        });
        sock.on("error", () => {
            // 忽略
        });
    });
    // listen 异步失败以 'error' 事件触发，无监听会升级为 uncaughtException 拖崩宿主进程；
    // 用 ready Promise 让调用方 await，失败时能被现有 try/catch 接住并走 teardown。
    const ready = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(sockPath, () => {
            server.on("error", () => { });
            resolve();
        });
    });
    return {
        ready,
        sendTo(instanceId, env) {
            const sock = conns.get(instanceId);
            if (!sock)
                return false;
            try {
                sock.write(JSON.stringify(env) + "\n");
                return true;
            }
            catch {
                return false;
            }
        },
        /** 向所有已连接的 follower 广播消息 */
        broadcast(env) {
            const data = JSON.stringify(env) + "\n";
            for (const sock of conns.values()) {
                try {
                    sock.write(data);
                }
                catch {
                    // 忽略单个写失败
                }
            }
        },
        has(instanceId) {
            return conns.has(instanceId);
        },
        followerIds() {
            return [...conns.keys()];
        },
        close() {
            // 主动断开所有已有连接
            for (const sock of conns.values()) {
                try {
                    sock.destroy();
                }
                catch {
                    // 忽略
                }
            }
            conns.clear();
            try {
                server.close();
            }
            catch {
                // 忽略
            }
            try {
                if (existsSync(sockPath))
                    unlinkSync(sockPath);
            }
            catch {
                // 忽略
            }
        },
    };
}
export function createIpcClient(sockPath, handlers) {
    let sock = null;
    let buf = "";
    let connected = false;
    const client = connect(sockPath);
    sock = client;
    client.on("connect", () => {
        connected = true;
        handlers.onConnect?.();
    });
    client.on("data", (data) => {
        buf += data.toString("utf-8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line)
                continue;
            try {
                const env = JSON.parse(line);
                if (env.type === "inbound")
                    handlers.onInbound?.(env);
                else if (env.type === "settings_changed")
                    handlers.onSettingsChanged?.(env.settings);
            }
            catch {
                // 忽略坏行
            }
        }
    });
    client.on("close", () => {
        connected = false;
        handlers.onClose?.();
    });
    client.on("error", () => {
        connected = false;
        handlers.onClose?.();
    });
    return {
        send(env) {
            if (connected && sock) {
                try {
                    sock.write(JSON.stringify(env) + "\n");
                }
                catch {
                    // 忽略
                }
            }
        },
        isConnected() {
            return connected;
        },
        close() {
            try {
                sock?.destroy();
            }
            catch {
                // 忽略
            }
        },
    };
}
