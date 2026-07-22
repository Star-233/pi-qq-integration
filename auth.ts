import type { AccessTokenResult, AuthManager, AuthDiagnostics } from "./types";
export type { AuthManager } from "./types";
import { error as logError } from "./logger";

const TOKEN_API = "https://bots.qq.com/app/getAppAccessToken";
const REFRESH_MARGIN_MS = 60_000; // 提前 60 秒刷新

/**
 * QQ Bot Access Token 管理器。
 * 负责获取和自动刷新 token。
 */
export function createAuthManager(
  appId: string,
  appSecret: string
): AuthManager {
  let _token: string | null = null;
  let _expiresAt: number = 0;
  let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let _lastRefreshTime: number | null = null;

  async function fetchToken(): Promise<string> {
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

    const result = (await resp.json()) as AccessTokenResult;
    _token = result.access_token;
    // expires_in 是秒，提前 REFRESH_MARGIN_MS 刷新
    _expiresAt = Date.now() + result.expires_in * 1000 - REFRESH_MARGIN_MS;

    return _token;
  }

  async function getToken(): Promise<string> {
    if (_token && Date.now() < _expiresAt) {
      return _token;
    }
    return await fetchToken();
  }

  /** 定时刷新 token 的后台循环 */
  function scheduleRefresh(): void {
    const timeUntilRefresh = Math.max(_expiresAt - Date.now(), 30_000);
    _refreshTimer = setTimeout(async () => {
      try {
        await fetchToken();
      } catch (err) {
        logError(`Token 刷新失败: ${err}`);
      }
      scheduleRefresh();
    }, timeUntilRefresh);
  }

  function startRefresh(): void {
    stopRefresh();
    if (_token) {
      scheduleRefresh();
    }
  }

  function stopRefresh(): void {
    if (_refreshTimer) {
      clearTimeout(_refreshTimer);
      _refreshTimer = null;
    }
  }

  function getDiagnostics(): AuthDiagnostics {
    return {
      hasToken: _token !== null,
      expiresAt: _expiresAt || null,
      expiresInMs: _expiresAt ? _expiresAt - Date.now() : null,
      lastRefreshTime: _lastRefreshTime,
    };
  }

  return { getToken, startRefresh, stopRefresh, getDiagnostics };
}
