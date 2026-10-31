/**
 * dsh 插件实现。
 *
 * 职责边界：
 *   - CodeBuddy 路由由本插件提供（官方登录态鉴权 + 渠道校验头 + 多账号轮换）；
 *   - 用户手动配置的任意模型 API 路由由官方 @deepseek-ai/dsh-llm-pi-ai 提供，
 *     本插件不重复实现，只做「模型目录合并」与「CodeBuddy 路由注册」。
 */

import z from '@deepseek-ai/schemastery';
import { CodeBuddyProvider } from './provider.js';
import { fetchModelCatalog, listAccounts } from './credentials.js';

export const name = 'llm-codebuddy';
export const inject = ['llm'];

/**
 * 运行时 schema。
 * cordis 要求 Config 是 schemastery schema（普通对象会在解析时报
 * `Cannot read properties of undefined (reading 'validate')`）。
 *
 * 插件自身的配置很少：账号选择、冷却时长、请求间隔、UA 覆盖。
 * 用户手动配置的模型 API 走 llm-pi-ai 的 `providers` 路由，不在这里重复声明。
 */
export const Config = z.object({
  /** 固定使用某个账号（.info 文件名片段或 uid）；留空则自动轮换。 */
  account: z.string().default(''),
  /** 账号被风控后的冷却时长（毫秒）。 */
  cooldownMs: z.number().default(30 * 60 * 1000),
  /** 相邻请求最小间隔（毫秒），避免高频触发服务端风控。 */
  minIntervalMs: z.number().default(1200),
  /** 覆盖 User-Agent；留空则使用默认的官方 CLI 身份。 */
  userAgent: z.string().default(''),
  /** CodeBuddy 路由在模型目录中的显示名。 */
  displayName: z.string().default('CodeBuddy'),
});

/** CodeBuddy 路由名。 */
const ROUTE = 'codebuddy-official';

/**
 * 生成 provider 目录条目（供 dsh 的模型选择界面展示）。
 */
function directoryEntry(provider, displayName) {
  return {
    provider,
    displayName,
    settingsNs: 'llm-codebuddy',
    settingsPath: ['providers', provider],
    declared: true,
  };
}

/**
 * 应用插件。
 * @param ctx cordis context
 * @param config 解析后的插件配置
 */
export function apply(ctx, config) {
  const provider = new CodeBuddyProvider({
    account: config.account || undefined,
    cooldownMs: config.cooldownMs,
    minIntervalMs: config.minIntervalMs,
    userAgent: config.userAgent || undefined,
    onEvent: (event, detail) => {
      const logger = ctx.logger;
      if (!logger) return;
      if (event === 'account-blocked') {
        logger.warn(`[codebuddy] account ${detail.nickname} was blocked (HTTP ${detail.status}); rotating`);
      } else if (event === 'domain-fallback') {
        logger.warn(`[codebuddy] all accounts unavailable; recovered by switching domain to ${detail.domain}`);
      } else if (event === 'token-refresh') {
        logger.info(`[codebuddy] refreshing token for ${detail.nickname}`);
      } else if (event === 'error') {
        logger.warn(`[codebuddy] ${detail.message}`);
      }
    },
  });

  // 载入账号；没有登录文件时只告警，不阻塞 harness 启动
  provider.init().then(
    (accounts) => {
      if (accounts.length === 0) {
        ctx.logger?.warn(
          '[codebuddy] no CodeBuddy login found. Sign in with the official client, '
          + 'or drop a *.info file into the auth directory.',
        );
      } else {
        ctx.logger?.info(`[codebuddy] loaded ${accounts.length} CodeBuddy account(s)`);
      }
    },
    (error) => {
      ctx.logger?.warn(`[codebuddy] failed to enumerate accounts: ${error.message}`);
    },
  );

  const adapter = {
    // LlmProviderInfo：id 必须等于路由名，name 不能为空
    providerInfo: () => ({
      id: ROUTE,
      name: config.displayName || 'CodeBuddy',
    }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => image,
    // LlmModelInfo：provider / id / name
    listModels: async () => {
      const catalog = await provider.models();
      if (!catalog.ok) return [];
      return catalog.models.map((id) => ({
        provider: ROUTE,
        id,
        name: id,
        inputModalities: ['text', 'image'],
      }));
    },
    // LlmResolvedModelInfo：附带 context / defaultMaxTokens
    resolveModel: async (providerRoute, model) => ({
      provider: providerRoute,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 50_000,
    }),
    // PreparedAdapterCall：把模型元数据与同一次 generation 的 stream 绑定在一起
    prepareCall: async (providerRoute, model) => ({
      model: {
        provider: providerRoute,
        id: model,
        name: model,
        inputModalities: ['text', 'image'],
        context: { contextWindow: 1_000_000 },
        defaultMaxTokens: 50_000,
      },
      stream: (options) => streamCodeBuddy(provider, options),
    }),
    stream: async function* (options) {
      yield* streamCodeBuddy(provider, options);
    },
  };

  ctx.llm.registerAdapter([ROUTE], adapter);

  // 把 CodeBuddy 路由加入可配置 provider 目录
  const directory = ctx.llm.registerConfigurableProviders([
    directoryEntry(ROUTE, config.displayName || 'CodeBuddy'),
  ]);

  ctx.on('loader/volatile-update', () => {
    try {
      directory.replace([directoryEntry(ROUTE, config.displayName || 'CodeBuddy')]);
    } catch (error) {
      ctx.logger?.error(`[codebuddy] failed to refresh provider directory: ${error.message}`);
    }
  });

  return provider;
}

/**
 * 把 dsh 的 GenerateOptions 转成 CodeBuddy 官方请求，并把 SSE 解析成 dsh 的 chunk 序列。
 *
 * dsh 的 StreamChunk 协议要求：
 *   block-start -> text-delta... -> block-end -> usage -> finish
 * 索引必须从 0 开始连续；工具调用用 tool-call-delta + tool-call 类型的 block-end。
 *
 * @param {CodeBuddyProvider} provider
 * @param {object} options dsh GenerateOptions
 */
async function* streamCodeBuddy(provider, options) {
  const messages = [];
  const system = options.systemPrompt ?? options.messages?.find((m) => m.role === 'system')?.content;
  // 官方渠道校验要求首条消息必须是 system
  if (system) {
    messages.push({ role: 'system', content: typeof system === 'string' ? system : JSON.stringify(system) });
  }
  for (const message of options.messages ?? []) {
    if (message.role === 'system') continue;
    messages.push({ role: message.role, content: message.content });
  }

  const body = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = 'auto';
  }

  const response = await provider.request(body);
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  // 每个逻辑块一个 index：0 是正文，之后依次是各工具调用
  let nextIndex = 0;
  let textIndex = -1;
  let textStarted = false;
  let textBuffer = '';
  let usage = null;
  let finishReason = 'stop';
  const toolIndexes = new Map();
  const toolStarted = new Map();
  const toolNames = new Map();
  const toolArgs = new Map();
  const toolIds = new Map();

  const openText = () => {
    if (textIndex < 0) {
      textIndex = nextIndex++;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = payload.choices?.[0]?.delta;
        const text = delta?.content;
        if (typeof text === 'string' && text.length > 0) {
          openText();
          if (!textStarted) {
            yield { type: 'block-start', index: textIndex, blockType: 'text' };
            textStarted = true;
          }
          textBuffer += text;
          yield { type: 'text-delta', index: textIndex, text };
        }

        const calls = delta?.tool_calls;
        if (Array.isArray(calls)) {
          for (const call of calls) {
            const key = call.index ?? 0;
            let idx = toolIndexes.get(key);
            if (idx === undefined) {
              idx = nextIndex++;
              toolIndexes.set(key, idx);
              toolStarted.set(idx, false);
            }
            if (typeof call.id === 'string' && call.id) {
              toolIds.set(idx, call.id);
            }
            const name = call.function?.name;
            const args = call.function?.arguments;
            if (!toolStarted.get(idx)) {
              yield { type: 'block-start', index: idx, blockType: 'tool-call' };
              toolStarted.set(idx, true);
            }
            if (typeof name === 'string' && name.length > 0) {
              toolNames.set(idx, name);
              yield { type: 'tool-call-delta', index: idx, id: call.id ?? '', name, argumentsDelta: '' };
            }
            if (typeof args === 'string' && args.length > 0) {
              toolArgs.set(idx, (toolArgs.get(idx) ?? '') + args);
              yield { type: 'tool-call-delta', index: idx, id: call.id ?? '', argumentsDelta: args };
            }
          }
        }

        const finish = payload.choices?.[0]?.finish_reason;
        if (finish) {
          finishReason = finish === 'tool_calls' ? 'tool-calls' : (finish === 'length' ? 'max-tokens' : 'stop');
        }

        if (payload.usage) {
          usage = {
            inputTokens: payload.usage.prompt_tokens ?? 0,
            outputTokens: payload.usage.completion_tokens ?? 0,
            totalTokens: payload.usage.total_tokens,
          };
        }
      }
    }
  }

  // 收尾：关闭未结束的块
  if (textIndex >= 0 && textStarted) {
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuffer } };
  }
  for (const [idx, name] of toolNames) {
    yield {
      type: 'block-end',
      index: idx,
      block: {
        type: 'tool-call',
        id: toolIds.get(idx) ?? '',
        name,
        arguments: toolArgs.get(idx) ?? '',
      },
    };
  }
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: finishReason } };
}

/** 供 CLI / 健康检查使用。 */
export async function status() {
  return { accounts: await listAccounts() };
}

export { fetchModelCatalog };
