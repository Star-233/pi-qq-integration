import { createServer, connect } from "node:net";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function createIpcServer(sockPath, handlers) {
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
    server.listen(sockPath);
    return {
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
        has(instanceId) {
            return conns.has(instanceId);
        },
        close() {
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
        // 连接失败/异常：触发 onClose 让 follower 走重试逻辑，避免静默卡死
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
