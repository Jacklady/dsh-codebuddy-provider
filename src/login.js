/**
 * CodeBuddy / WorkBuddy 扫码登录。
 *
 * 官方 CLI 的登录本质是一个「授权码换 token」流程，本模块把它拆成三步：
 *
 *   1. POST /v2{prefix}/auth/state?platform=<p>   → 拿到 state 与授权页地址
 *   2. 用户在浏览器里完成扫码 / 账号密码登录（授权页自己会展示二维码）
 *   3. GET  /v2{prefix}/auth/token?state=<state>  → 轮询直到返回 token
 *
 * 拿到 token 后，再调 /v2/plugin/account 取账号资料，按官方 .info 格式落盘，
 * 于是 credentials.js 能像读官方客户端写的登录文件一样使用它。
 *
 * 协议依据（实测自官方 CLI 与登录页前端）：
 *   - code 11217「login ing...」：扫码尚未完成，继续轮询
 *   - code 12151「no choose login account」：需要先选择账号
 *   - 授权页自带微信 / QQ 扫码，alias 形如 wechat_qrcode_web / qq_login
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { authDirs, BACKENDS, DEFAULT_BACKEND, USER_AGENT, CLI_VERSION } from './credentials.js';

/** 各域对应的接口前缀与平台名（取自官方 product.json）。 */
export const PLATFORMS = {
  'www.workbuddy.ai': { host: 'https://www.workbuddy.ai', prefix: '/plugin', platform: 'workbuddy' },
  'www.codebuddy.ai': { host: 'https://www.codebuddy.ai', prefix: '/plugin', platform: 'codebuddy' },
  'www.codebuddy.cn': { host: 'https://copilot.tencent.com', prefix: '/plugin', platform: 'codebuddy' },
};

export const DEFAULT_LOGIN_DOMAIN = 'www.workbuddy.ai';

/** 轮询等待扫码时的业务码。 */
const PENDING_TOKEN_CODE = 11217;
const PENDING_ACCOUNT_CODE = 12151;

/** 未登录时使用的请求头（官方 CLI 用 X-No-Authorization 声明匿名访问）。 */
function anonymousHeaders() {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
    'x-product': 'SaaS',
    'x-product-version': CLI_VERSION,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
  };
}

/** 从后端响应里取出业务码。 */
function readCode(payload) {
  const code = payload?.code;
  return typeof code === 'number' ? code : null;
}

/**
 * 发起一次登录，返回待扫码的会话。
 *
 * @param {{domain?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{state: string, authUrl: string, domain: string, host: string}>}
 */
export async function startLogin(options = {}) {
  const domain = options.domain ?? DEFAULT_LOGIN_DOMAIN;
  const config = PLATFORMS[domain];
  if (!config) {
    throw new Error(`unsupported login domain: ${domain}`);
  }
  const url = `${config.host}/v2${config.prefix}/auth/state?platform=${config.platform}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: anonymousHeaders(),
    body: '{}',
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || readCode(payload) !== 0) {
    throw new Error(`failed to start login: HTTP ${response.status} ${payload?.msg ?? ''}`);
  }
  const data = payload.data ?? {};
  if (!data.state || !data.authUrl) {
    throw new Error(`unexpected login response: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return { state: data.state, authUrl: data.authUrl, domain, host: config.host };
}

/**
 * 轮询直到扫码完成。
 *
 * @param {{state: string, domain?: string, host?: string, intervalMs?: number, timeoutMs?: number,
 *          onPoll?: (info: {elapsedMs: number, code: number|null, msg: string}) => void}} options
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number, domain: string}>}
 */
export async function waitForToken(options) {
  const { state } = options;
  const host = options.host ?? PLATFORMS[options.domain ?? DEFAULT_LOGIN_DOMAIN].host;
  const prefix = PLATFORMS[options.domain ?? DEFAULT_LOGIN_DOMAIN].prefix;
  const interval = options.intervalMs ?? 2000;
  const timeout = options.timeoutMs ?? 5 * 60 * 1000;
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const url = `${host}/v2${prefix}/auth/token?state=${encodeURIComponent(state)}`;
    let payload = {};
    let status = 0;
    try {
      const response = await fetch(url, {
        headers: anonymousHeaders(),
        signal: AbortSignal.timeout(20_000),
      });
      status = response.status;
      payload = await response.json().catch(() => ({}));
    } catch (err) {
      payload = { code: null, msg: err.message };
    }

    const code = readCode(payload);
    options.onPoll?.({ elapsedMs: Date.now() - started, code, msg: String(payload?.msg ?? '') });

    const data = payload?.data;
    if (data && typeof data.accessToken === 'string' && data.accessToken.length > 0) {
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? '',
        expiresAt: Number(data.expiresAt ?? 0),
        refreshExpiresAt: Number(data.refreshExpiresAt ?? 0),
        domain: data.domain ?? options.domain ?? DEFAULT_LOGIN_DOMAIN,
      };
    }

    if (code !== PENDING_TOKEN_CODE && status !== 200) {
      throw new Error(`login failed: HTTP ${status} ${payload?.msg ?? ''}`);
    }
    if (code === PENDING_ACCOUNT_CODE) {
      // 服务端要求先选择账号，登录页会自动处理；这里继续等待即可。
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('login timed out: the QR code was not confirmed in time');
}

/**
 * 用 token 拉取账号资料。
 *
 * @param {{accessToken: string, domain: string, host: string}} session
 */
export async function fetchAccount(session) {
  const config = PLATFORMS[session.domain] ?? PLATFORMS[DEFAULT_LOGIN_DOMAIN];
  const host = session.host ?? config.host;
  const response = await fetch(`${host}/v2${config.prefix}/account`, {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      accept: 'application/json',
      'user-agent': USER_AGENT,
      'x-product': 'SaaS',
      'x-product-version': CLI_VERSION,
      'x-user-id': session.uid ?? '',
      'x-domain': session.domain,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || readCode(payload) !== 0) {
    throw new Error(`failed to fetch account: HTTP ${response.status} ${payload?.msg ?? ''}`);
  }
  return payload.data ?? {};
}

/**
 * 把登录结果写成官方 .info 格式。
 *
 * 官方 CLI 写的是 `<authId>.info`，其中 authId 来自 product.json 的
 * authentication.id（workbuddy 桌面端为 workbuddy-desktop）。
 * 为了多账号并存，这里沿用「按 uid 分文件」的约定。
 *
 * @param {{session: object, account: object, fileName?: string, dir?: string}} options
 * @returns {Promise<string>} 写入的文件路径
 */
export async function writeAccountFile(options) {
  const { session, account } = options;
  const dir = options.dir ?? authDirs()[0];
  const uid = account.uid ?? randomUUID();
  const fileName = options.fileName ?? `workbuddy-desktop-ai.${uid}.info`;
  const file = path.join(dir, fileName);

  const now = Date.now();
  const expiresAt = session.expiresAt || now + 3600 * 1000;
  const refreshExpiresAt = session.refreshExpiresAt || now + 30 * 24 * 3600 * 1000;

  const profile = {
    accountType: account.accountType ?? '',
    areaInfoComplete: account.areaInfoComplete ?? true,
    deployStatus: account.deployStatus ?? { detailMsg: '', statusCode: 0, statusMsg: '' },
    idp: account.idp ?? '',
    isAdmin: account.isAdmin ?? false,
    isCreator: account.isCreator ?? false,
    isCurrentOneIdEnterprise: account.isCurrentOneIdEnterprise ?? false,
    isCurrentOneIdPersonal: account.isCurrentOneIdPersonal ?? false,
    isFirstLogin: account.isFirstLogin ?? true,
    lastLogin: true,
    nickname: account.nickname ?? '',
    oneidAccountId: account.oneidAccountId ?? '',
    pluginEnabled: account.pluginEnabled ?? true,
    sso: account.sso ?? { domain: '', domainModifiedTimes: 0 },
    type: account.type ?? 'personal',
    uid,
    uin: account.uin ?? '',
  };

  const info = {
    account: profile,
    accounts: [profile],
    allAccounts: [profile],
    auth: {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      tokenType: 'Bearer',
      scope: 'openid profile offline_access email',
      sessionState: '',
      domain: session.domain,
      expiresAt,
      expiresIn: Math.max(0, Math.floor((expiresAt - now) / 1000)),
      refreshExpiresAt,
      refreshExpiresIn: Math.max(0, Math.floor((refreshExpiresAt - now) / 1000)),
      lastRefreshTime: now,
      notBeforePolicy: 0,
    },
  };

  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(info, null, 2), 'utf-8');
  await fs.rename(tmp, file);
  return file;
}

/**
 * 完整扫码登录流程：发起 → 等待扫码 → 拉账号 → 落盘。
 *
 * @param {{domain?: string, dir?: string, onAuthUrl?: (url: string) => void,
 *          onPoll?: (info: object) => void, timeoutMs?: number}} [options]
 */
export async function login(options = {}) {
  const started = await startLogin(options);
  options.onAuthUrl?.(started.authUrl);

  const session = await waitForToken({ ...started, ...options });
  const account = await fetchAccount({ ...session, host: started.host });
  const file = await writeAccountFile({
    session,
    account,
    dir: options.dir,
  });

  return { file, account, domain: started.domain };
}
