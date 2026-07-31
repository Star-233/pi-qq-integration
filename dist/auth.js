import { error as logError } from "./logger.js";
import { ENDPOINTS, DEFAULTS } from "./constants.js";
const TOKEN_API = ENDPOINTS.TOKEN;
const REFRESH_MARGIN_MS = DEFAULTS.TOKEN_REFRESH_MARGIN_MS;
/** 连续刷新失败超过此阈值触发致命错误回调 */
const MAX_REFRESH_FAILURES = 3;
/**
 * QQ Bot Access Token 管理器。
 * 负责获取和自动刷新 token。
 */
export function createAuthManager(appId, appSecret) {
    let _token = null;
    let _expiresAt = 0;
    let _refreshTimer = null;
    let _lastRefreshTime = null;
    let _consecutiveFailures = 0;
    const _fatalHandlers = [];
    function onFatalError(handler) {
        _fatalHandlers.push(handler);
    }
    async function fetchToken() {
        _lastRefreshTime = Date.now();
        const resp = await fetch(TOKEN_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appId, clientSecret: appSecret }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`获取 Access Token 失败 (${resp.status}): ${text}`);
        }
        const result = (await resp.json());
        _token = result.access_token;
        _expiresAt = Date.now() + result.expires_in * 1000 - REFRESH_MARGIN_MS;
        _consecutiveFailures = 0; // 成功则重置
        return _token;
    }
    async function getToken() {
        if (_token && Date.now() < _expiresAt) {
            return _token;
        }
        return await fetchToken();
    }
    /** 定时刷新 token 的后台循环 */
    function scheduleRefresh() {
        const timeUntilRefresh = Math.max(_expiresAt - Date.now(), DEFAULTS.TOKEN_REFRESH_MIN_MS);
        _refreshTimer = setTimeout(async () => {
            try {
                await fetchToken();
            }
            catch (err) {
                _consecutiveFailures++;
                logError(`Token 刷新失败 (${_consecutiveFailures}/${MAX_REFRESH_FAILURES}): ${err}`);
                if (_consecutiveFailures >= MAX_REFRESH_FAILURES) {
                    const fatalErr = new Error(`Token 连续刷新失败 ${_consecutiveFailures} 次，连接已不可用`);
                    logError(`Token 致命错误: ${fatalErr.message}`);
                    for (const handler of _fatalHandlers) {
                        try {
                            handler(fatalErr);
                        }
                        catch {
                            // 忽略回调异常
                        }
                    }
                    stopRefresh();
                    return; // 停止调度
                }
            }
            scheduleRefresh();
        }, timeUntilRefresh);
    }
    function startRefresh() {
        stopRefresh();
        if (_token) {
            scheduleRefresh();
        }
    }
    function stopRefresh() {
        if (_refreshTimer) {
            clearTimeout(_refreshTimer);
            _refreshTimer = null;
        }
    }
    function getDiagnostics() {
        return {
            hasToken: _token !== null,
            expiresAt: _expiresAt || null,
            expiresInMs: _expiresAt ? _expiresAt - Date.now() : null,
            lastRefreshTime: _lastRefreshTime,
            consecutiveRefreshFailures: _consecutiveFailures,
        };
    }
    return { getToken, startRefresh, stopRefresh, getDiagnostics, onFatalError };
}
