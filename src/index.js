/**
 * dsh-codebuddy-provider
 *
 * 把 CodeBuddy / WorkBuddy 官方账号接入 DeepSeek Harness，并允许在 dsh 里
 * 手动配置任意模型 API。
 *
 * 设计要点：
 *   1. 复用官方 @deepseek-ai/dsh-llm-pi-ai 的 provider 目录与模型发现机制；
 *      用户的「手动配置模型 API」走官方 providers.<name> 路由，本插件不重复实现。
 *   2. CodeBuddy 走独立路由：它的鉴权是官方登录态（多账号 .info 文件）而非 API Key，
 *      并且请求必须带官方渠道校验头，无法用通用 OpenAI 兼容配置表达。
 *   3. 在 pi-ai 的 fetch 层注入 CodeBuddy 请求身份，并实现多账号轮换与域级降级。
 *
 * 配置示例（profile 的 cordis.patch.yml）：
 *
 *   - id: llm-pi-ai
 *     config:
 *       providers:
 *         codebuddy:
 *           displayName: CodeBuddy
 *           api: openai-completions
 *           baseURL: https://www.workbuddy.ai/v1
 *           headers:
 *             Authorization: Bearer sk-local-codebuddy-proxy
 *
 *   - id: agent-default-model
 *     config:
 *       provider: codebuddy
 *       model: deepseek-v4.1-flash
 */

import { Config, apply, inject, name } from './plugin.js';

export { Config, apply, inject, name };
export { CodeBuddyProvider, classifyError } from './provider.js';
export {
  BACKENDS,
  CHAT_PATH,
  CONFIG_PATH,
  REFRESH_PATH,
  ACCOUNT_PATH,
  findAuthFiles,
  listAccounts,
  openCredentialManager,
  fetchModelCatalog,
} from './credentials.js';
