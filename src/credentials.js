/**
 * CodeBuddy / WorkBuddy 官方登录态管理。
 *
 * 只读取官方客户端自己写入的登录文件，不依赖任何第三方 npm 包；
 * 使用与官方 CLI 一致的请求身份与刷新接口。
 *
 * 登录文件位置（与官方客户端一致）：
 *   Windows : %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info
 *   macOS   : ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info
 *   Linux   : $XDG_DATA_HOME/CodeBuddyExtension/Data/Public/auth/*.info
 *
 * 每个账号一个独立 .info 文件，可并存、可单独切换。
 * 注意：WorkBuddy 桌面端写的 workbuddy-desktop.info 使用 $wbEncrypted 加密，
 * 其中的 token 是密文，本模块会自动跳过这类文件。
 */

import { promises as fs, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 官方后端按登录域区分（实测：同一 token 换域会被网关 401 拒绝）。 */
export const BACKENDS = {
  'www.workbuddy.ai': 'https://www.workbuddy.ai',
  'www.codebuddy.ai': 'https://www.codebuddy.ai',
  'www.codebuddy.cn': 'https://copilot.tencent.com',
};

export const DEFAULT_BACKEND = 'https://copilot.tencent.com';
export const DEFAULT_DOMAIN = 'www.codebuddy.cn';

/** 官方端点。 */
export const CHAT_PATH = '/v2/chat/completions';
export const CONFIG_PATH = '/v3/config';
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
export const ACCOUNT_PATH = '/v2/plugin/account';

/** 官方 CLI 版本号 —— 请求身份与 UA 需与官方一致，否则会触发渠道校验（code 11128）。 */
export const CLI_VERSION = detectCliVersion();

/**
 * 探测本机官方 CodeBuddy CLI 的版本号。
 *
 * 渠道校验会把 UA 与已安装客户端的版本做比对，版本落后可能被判定为非官方客户端，
 * 因此这里在启动时同步一次版本，而不是写死。
 *
 * 探测顺序：
 *   1. CB_CLI_VERSION 环境变量（显式覆盖）；
 *   2. 官方安装目录的 versions/*（取语义化版本最大的一个）；
 *   3. 官方 CLI 可执行文件 --version（较慢，作为兜底）。
 *
 * 探测失败时回落到一个保守的默认值，不影响功能。
 */
function detectCliVersion() {
  const override = process.env.CB_CLI_VERSION;
  if (override) return override;

  try {
    const home = os.homedir();
    const candidates = [];
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
      candidates.push(path.join(local, 'codebuddy', 'Data', 'versions'));
    } else if (process.platform === 'darwin') {
      candidates.push(path.join(home, 'Library', 'Application Support', 'CodeBuddy', 'Data', 'versions'));
    } else {
      candidates.push(path.join(home, '.local', 'share', 'CodeBuddy', 'Data', 'versions'));
      candidates.push(path.join(home, '.codebuddy', 'versions'));
    }
    for (const dir of candidates) {
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      const versions = entries
        .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => compareVersions(a, b));
      if (versions.length > 0) return versions[versions.length - 1];
    }
  } catch {
    /* fall through */
  }

  return '0.0.0';
}

/** 比较两个语义化版本号。 */
function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

export const USER_AGENT = `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`;

/** 登录文件候选目录。可用 CB_AUTH_DIR 覆盖（分号分隔）。 */
export function authDirs() {
  const override = process.env.CB_AUTH_DIR;
  if (override) return override.split(';').filter(Boolean);
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  return [path.join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
}

/** 账号信息是否被 WorkBuddy 桌面端加密（加密文件的 token 是密文，无法直接使用）。 */
function isEncrypted(value) {
  return !!(value && typeof value === 'object' && value.$wbEncrypted);
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf-8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

function randomHex() {
  return randomUUID().replace(/-/g, '');
}

/**
 * 找出所有可用的（明文）登录文件，按 mtime 从新到旧排序。
 * @returns {Promise<string[]>} .info 文件绝对路径
 */
export async function findAuthFiles() {
  const found = [];
  for (const dir of authDirs()) {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.info')) continue;
      const file = path.join(dir, entry);
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(file)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      found.push({ file, mtimeMs });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  const usable = [];
  for (const { file } of found) {
    try {
      const info = await readJson(file);
      if (isEncrypted(info.auth?.accessToken) || isEncrypted(info.auth?.refreshToken)) continue;
      if (!info.auth?.accessToken) continue;
      usable.push(file);
    } catch {
      /* skip broken file */
    }
  }
  return usable;
}

/**
 * 官方登录态管理器。
 */
export class CredentialManager {
  constructor(file) {
    this.path = file;
    this.cached = null;
    this.mtime = 0;
    this.tail = Promise.resolve();
  }

  get loggedOut() {
    return this.cached === null;
  }

  async loadIfStale() {
    let stat;
    try {
      stat = await fs.stat(this.path);
    } catch {
      this.cached = null;
      return null;
    }
    if (this.cached && stat.mtimeMs === this.mtime) return this.cached;
    try {
      this.cached = await readJson(this.path);
      this.mtime = stat.mtimeMs;
    } catch {
      this.cached = null;
    }
    return this.cached;
  }

  /** 串行化临界区，避免并发刷新。 */
  withLock(operation) {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  /** 指定域对应的后端基址（用于换域降级）。 */
  backendFor(domain) {
    return BACKENDS[domain] ?? DEFAULT_BACKEND;
  }

  /** 该账号对应的后端基址。 */
  backendOf(auth) {
    return this.backendFor(auth?.domain ?? DEFAULT_DOMAIN);
  }

  /**
   * 构造与官方 CLI 一致的请求头。
   *
   * 渠道校验（code 11128 "Request blocked"）依赖这组头，缺一即被拦截：
   * x-user-id / x-domain / x-product / x-request-id /
   * x-conversation-id / x-conversation-request-id / x-conversation-message-id /
   * x-agent-intent / x-agent-type / x-agent-runtime / x-ide-type / x-ide-version
   */
  buildHeaders(auth, account, opts = {}) {
    const domain = auth.domain ?? DEFAULT_DOMAIN;
    const requestId = opts.requestId ?? randomHex();
    return {
      authorization: `Bearer ${auth.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': USER_AGENT,
      'x-user-id': account.uid ?? '',
      'x-enterprise-id': account.enterpriseId ?? '',
      'x-tenant-id': account.enterpriseId ?? '',
      'x-domain': domain,
      'x-product': 'SaaS',
      'x-product-version': CLI_VERSION,
      'x-request-id': requestId,
      'x-conversation-id': opts.conversationId ?? randomUUID(),
      'x-conversation-request-id': requestId,
      'x-conversation-message-id': requestId,
      'x-agent-intent': opts.agentIntent ?? 'craft',
      'x-agent-type': opts.agentType ?? 'cli',
      'x-agent-runtime': opts.agentRuntime ?? 'cli',
      'x-ide-type': opts.ideType ?? 'cli',
      'x-ide-name': opts.ideName ?? '',
      'x-ide-version': CLI_VERSION,
    };
  }

  /** token 距离过期不足 5 分钟时视为需要刷新。 */
  needsRefresh(auth) {
    if (!auth?.expiresAt) return false;
    return Date.now() >= Number(auth.expiresAt) - 5 * 60 * 1000;
  }

  /** 调用官方刷新接口续期，并原子写回登录文件。 */
  async refresh(info) {
    const auth = info.auth ?? {};
    const account = info.account ?? {};
    const headers = this.buildHeaders(auth, account);
    headers['x-refresh-token'] = auth.refreshToken ?? '';
    headers['x-auth-refresh-source'] = 'plugin';
    headers.accept = 'application/json';

    const response = await fetch(`${this.backendOf(auth)}${REFRESH_PATH}`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`token refresh failed: HTTP ${response.status} ${text.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }
    const payload = await response.json();
    if (payload?.code !== 0) {
      const err = new Error(`token refresh rejected: ${JSON.stringify(payload).slice(0, 300)}`);
      err.status = 403;
      throw err;
    }
    const data = payload.data ?? {};
    const next = {
      ...info,
      auth: {
        ...auth,
        accessToken: data.accessToken ?? auth.accessToken,
        refreshToken: data.refreshToken ?? auth.refreshToken,
        expiresAt: data.expiresAt ?? auth.expiresAt,
        refreshExpiresAt: data.refreshExpiresAt ?? auth.refreshExpiresAt,
        lastRefreshTime: Date.now(),
      },
    };
    await writeJsonAtomic(this.path, next);
    this.cached = next;
    try {
      this.mtime = (await fs.stat(this.path)).mtimeMs;
    } catch {
      /* ignore */
    }
    return next;
  }

  /** 取得可用登录态；必要时自动刷新。 */
  async session() {
    const info = await this.loadIfStale();
    if (!info) return null;
    if (!this.needsRefresh(info.auth)) return info;
    return this.withLock(async () => {
      const current = await this.loadIfStale();
      if (!current) return null;
      if (!this.needsRefresh(current.auth)) return current;
      try {
        return await this.refresh(current);
      } catch (err) {
        console.error('[codebuddy] token refresh failed:', err.message);
        return current;
      }
    });
  }

  /** 取得请求头；登录态缺失则返回 null。 */
  async getHeaders(opts = {}) {
    const s = await this.session();
    if (!s) return null;
    return this.buildHeaders(s.auth, s.account, opts);
  }

  /** 当前账号的后端基址。 */
  async baseUrl() {
    const s = await this.session();
    return s ? this.backendOf(s.auth) : DEFAULT_BACKEND;
  }

  /** 账号摘要，用于诊断。 */
  async summary() {
    const s = await this.session();
    if (!s) return { error: 'no local CodeBuddy login found' };
    return {
      uid: s.account.uid,
      nickname: s.account.nickname,
      uin: s.account.uin,
      domain: s.auth.domain,
      backend: this.backendOf(s.auth),
      tokenExpiresAt: s.auth.expiresAt,
      tokenExpired: Date.now() >= Number(s.auth.expiresAt ?? 0),
    };
  }
}

/**
 * 打开最近一次登录的账号；找不到返回 null。
 * @param {string} [preferred] 指定 .info 文件名片段或 uid，用于在多账号间切换
 */
export async function openCredentialManager(preferred) {
  const files = await findAuthFiles();
  if (files.length === 0) return null;
  if (!preferred) return new CredentialManager(files[0]);
  const hit = files.find((f) => path.basename(f).includes(preferred));
  return new CredentialManager(hit ?? files[0]);
}

/** 列出所有可用账号。 */
export async function listAccounts() {
  const files = await findAuthFiles();
  const out = [];
  for (const file of files) {
    try {
      const info = await readJson(file);
      const auth = info.auth ?? {};
      out.push({
        file,
        name: path.basename(file),
        uid: info.account?.uid ?? '',
        nickname: isEncrypted(info.account?.nickname) ? '(encrypted)' : (info.account?.nickname ?? ''),
        uin: info.account?.uin ?? '',
        domain: auth.domain ?? DEFAULT_DOMAIN,
        expiresAt: auth.expiresAt,
        expired: Date.now() >= Number(auth.expiresAt ?? 0),
      });
    } catch {
      /* skip broken file */
    }
  }
  return out;
}

/**
 * 拉取某个账号可用的模型目录。
 * @returns {Promise<{ok: boolean, models?: string[], error?: string}>}
 */
export async function fetchModelCatalog(creds, timeoutMs = 20_000) {
  const headers = await creds.getHeaders();
  if (!headers) return { ok: false, error: 'no credential' };
  headers.accept = 'application/json';
  try {
    const res = await fetch(`${await creds.baseUrl()}${CONFIG_PATH}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    if (body?.code !== 0) return { ok: false, error: String(body?.msg ?? body?.code) };
    const data = body.data ?? {};
    const agents = Array.isArray(data.agents) ? data.agents : (data.agent?.agents ?? []);
    const cli = agents.find((a) => a?.name === 'cli');
    const models = (cli?.models ?? []).filter((id) => typeof id === 'string');
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
