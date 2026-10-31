/**
 * CodeBuddy / WorkBuddy provider —— 把官方账号接入 dsh 的 LLM seam。
 *
 * 特性：
 *   - 多账号轮换：某个账号被风控（403 / code 11140）时自动冷却并切到下一个；
 *   - 域级降级：所有账号都失效时，换到另一个域重试（风控按「域 + 账号」隔离）；
 *   - token 自动续期：临近过期时调用官方刷新接口，并原子写回登录文件；
 *   - 官方协议：首条消息补 system、使用官方请求身份与 UA、通过渠道校验。
 */

import {
  CHAT_PATH,
  DEFAULT_DOMAIN,
  openCredentialManager,
  listAccounts,
  fetchModelCatalog,
} from './credentials.js';

/** 账号被风控后的冷却时长。 */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/** 相邻请求最小间隔，避免高频触发服务端风控。 */
const DEFAULT_MIN_INTERVAL_MS = 1200;

/**
 * 域降级候选顺序。
 * 实测：同一 token 在 workbuddy.ai 域可用、在 copilot.tencent.com 域被网关 401 拒绝，
 * 说明风控按域隔离，换域往往能立刻恢复服务。
 */
const DOMAIN_FALLBACKS = ['www.workbuddy.ai', 'www.codebuddy.cn', 'www.codebuddy.ai'];

/**
 * 错误分类。
 *   blocked —— 账号级风控（403 / code 11140），需要换号并冷却
 *   auth    —— token 无效或过期（401），先尝试刷新再决定换号
 */
export function classifyError(status, text) {
  if (/"code"\s*:\s*11140|11140|已被限制使用|account.*(restricted|abnormal)/i.test(text ?? '')) {
    return 'blocked';
  }
  if (status === 403) return 'blocked';
  if (status === 401) return 'auth';
  return 'other';
}

/**
 * CodeBuddy provider。
 */
export class CodeBuddyProvider {
  /**
   * @param {object} options
   * @param {string} [options.account] 指定账号（.info 文件名片段或 uid）
   * @param {number} [options.cooldownMs] 账号冷却时长
   * @param {number} [options.minIntervalMs] 相邻请求最小间隔
   * @param {string} [options.userAgent] 覆盖 UA
   * @param {(event: string, detail?: unknown) => void} [options.onEvent] 事件回调
   */
  constructor(options = {}) {
    this.account = options.account;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.userAgent = options.userAgent;
    this.onEvent = options.onEvent ?? (() => {});
    /** uid -> 冷却截止时间 */
    this.cooldown = new Map();
    /** 上一次请求上游的时间 */
    this.lastRequestAt = 0;
    /** 当前选中的账号下标 */
    this.accountIndex = 0;
    /** @type {Array<object>} */
    this.accounts = [];
  }

  /** 载入账号列表。 */
  async init() {
    this.accounts = await listAccounts();
    this.onEvent('accounts', this.accounts.map((a) => a.nickname || a.uid));
    return this.accounts;
  }

  /** 当前冷却剩余毫秒（0 表示可用）。 */
  cooldownRemaining(uid) {
    const until = this.cooldown.get(uid) ?? 0;
    return Math.max(0, until - Date.now());
  }

  /** 取一个可用账号（跳过冷却中的）。 */
  async pickAccount() {
    if (this.accounts.length === 0) await this.init();
    if (this.accounts.length === 0) return null;
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (this.accountIndex + i) % this.accounts.length;
      if (this.cooldownRemaining(this.accounts[idx].uid) > 0) continue;
      this.accountIndex = idx;
      const creds = await openCredentialManager(this.account ?? this.accounts[idx].uid);
      if (creds) return { creds, account: this.accounts[idx] };
    }
    // 全部在冷却中：退回第一个，等待冷却结束
    this.accountIndex = 0;
    const creds = await openCredentialManager(this.account ?? this.accounts[0].uid);
    return creds ? { creds, account: this.accounts[0] } : null;
  }

  /** 请求间隔控制。 */
  async throttle() {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  /** 构造上游请求头（叠加自定义 UA）。 */
  async buildRequestHeaders(creds, domainOverride) {
    const headers = await creds.getHeaders();
    if (!headers) throw new Error('no CodeBuddy credential available');
    if (this.userAgent) headers['user-agent'] = this.userAgent;
    if (domainOverride) headers['x-domain'] = domainOverride;
    return headers;
  }

  /**
   * 调用官方推理接口。
   * @returns {Promise<Response>}
   */
  async chat(body, { domainOverride } = {}) {
    const picked = await this.pickAccount();
    if (!picked) throw new Error('no CodeBuddy account configured');
    const headers = await this.buildRequestHeaders(picked.creds, domainOverride);
    const base = domainOverride
      ? picked.creds.backendFor(domainOverride)
      : await picked.creds.baseUrl();
    await this.throttle();
    return fetch(base + CHAT_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  /**
   * 带自愈能力的对话请求。
   *
   * 依次尝试：当前账号 -> 换号 -> 换域。
   * @param {object} body OpenAI Chat Completions 请求体
   * @param {AbortSignal} [signal]
   * @returns {Promise<Response>} 成功返回 2xx 的响应
   */
  async request(body, signal) {
    const attempts = Math.min(this.accounts.length || 1, 3);
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const picked = await this.pickAccount();
      if (!picked) break;
      let response;
      try {
        response = await this.chat(body);
      } catch (err) {
        lastError = err;
        this.onEvent('error', { message: err.message });
        this.cooldown.set(picked.account.uid, Date.now() + this.cooldownMs);
        this.accountIndex = (this.accountIndex + 1) % Math.max(1, this.accounts.length);
        continue;
      }

      if (response.ok) return response;

      const text = await response.text();
      const kind = classifyError(response.status, text);

      if (kind === 'auth') {
        // token 失效：强制刷新一次再重试本账号
        this.onEvent('token-refresh', { nickname: picked.account.nickname });
        try {
          const session = await picked.creds.session();
          if (session?.auth) {
            await picked.creds.refresh(session);
            const retry = await this.chat(body);
            if (retry.ok) return retry;
            await retry.text().catch(() => {});
          }
        } catch (err) {
          this.onEvent('error', { message: `refresh failed: ${err.message}` });
        }
      }

      if (kind === 'blocked' || kind === 'auth') {
        this.cooldown.set(picked.account.uid, Date.now() + this.cooldownMs);
        this.onEvent('account-blocked', {
          nickname: picked.account.nickname,
          status: response.status,
        });
        this.accountIndex = (this.accountIndex + 1) % Math.max(1, this.accounts.length);
        lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
        continue;
      }

      // 其它错误：原样回传给调用方
      return new Response(text, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 账号全失效 -> 换域重试
    const currentDomain = this.accounts[this.accountIndex]?.domain ?? DEFAULT_DOMAIN;
    for (const alt of DOMAIN_FALLBACKS.filter((d) => d !== currentDomain)) {
      try {
        const picked = await this.pickAccount();
        if (!picked) break;
        const response = await this.chat(body, { domainOverride: alt });
        if (response.ok) {
          this.onEvent('domain-fallback', { domain: alt });
          return response;
        }
        await response.text().catch(() => {});
      } catch (err) {
        this.onEvent('error', { message: `domain ${alt} failed: ${err.message}` });
      }
    }

    throw lastError ?? new Error('all CodeBuddy accounts unavailable');
  }

  /** 拉取账号可用模型列表。 */
  async models() {
    const picked = await this.pickAccount();
    if (!picked) return { ok: false, error: 'no account' };
    return fetchModelCatalog(picked.creds);
  }

  /** 诊断信息。 */
  async status() {
    if (this.accounts.length === 0) await this.init();
    return {
      accounts: this.accounts.map((a) => ({
        ...a,
        cooling: this.cooldownRemaining(a.uid) > 0,
        cooldownRemainingMs: this.cooldownRemaining(a.uid),
      })),
      current: this.accounts[this.accountIndex]?.nickname ?? null,
    };
  }
}
