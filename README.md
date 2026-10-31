# dsh-codebuddy-provider

> 中文文档见 [README.zh.md](./README.zh.md)

把 **CodeBuddy / WorkBuddy 官方账号**接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh），并允许你在 dsh 里**手动配置任意模型 API**。

- 多账号轮换：某个号被风控时自动冷却并切到下一个
- 域级降级：所有账号都失效时自动换域重试（风控按「域 + 账号」隔离）
- token 自动续期：临近过期时调用官方刷新接口并原子写回登录文件
- 官方协议：使用与官方 CLI 一致的请求身份与 UA，通过服务端渠道校验
- **手动配置模型 API**：任意 OpenAI 兼容端点都能在 dsh 里配，不限于 CodeBuddy

---

## Quick Start

### 1. 准备账号

用官方 CodeBuddy / WorkBuddy 客户端登录一次。登录文件位于：

| 平台 | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info` |
| Linux | `$XDG_DATA_HOME/CodeBuddyExtension/Data/Public/auth/*.info` |

> 也可以从别处导入 `.info` 文件（见下方「导入账号」）。

### 2. 安装

```powershell
# 安装到指定 profile
.\scripts\install.ps1 -Profile qq

# 安装 + 导入账号 + 设为默认模型
.\scripts\install.ps1 -Profile qq -Accounts C:\path\to\accounts -Enable

# 卸载
.\scripts\install.ps1 -Profile qq -Uninstall
```

### 3. 验证

```bash
dsh --profile qq headless "你好"
```

---

## Configuring model APIs manually

本插件**不重复实现**通用 provider——那部分由官方 `@deepseek-ai/dsh-llm-pi-ai` 提供。
你可以在 dsh 的 `cordis.patch.yml` 里自由声明任意 OpenAI 兼容端点：

```yaml
- id: llm-pi-ai
  config:
    providers:
      # 任意 OpenAI 兼容 API —— 走官方能力，无需本插件
      my-gateway:
        displayName: My Gateway
        api: openai-completions
        baseURL: https://api.example.com/v1
        apiKeyEnv: MY_GATEWAY_KEY
        models:
          - id: qwen-max
            contextWindow: 128000
            maxTokens: 8000

      # 官方 DeepSeek
      deepseek:
        displayName: DeepSeek
        api: openai-completions
        baseURL: https://api.deepseek.com/v1
        apiKeyEnv: DEEPSEEK_API_KEY
        models:
          - id: deepseek-chat
            contextWindow: 128000
            maxTokens: 8192
```

然后在 dsh 的 Models 页面里把 API Key 存进凭据服务，或直接导出环境变量
`MY_GATEWAY_KEY` / `DEEPSEEK_API_KEY`。

> `apiKeyEnv` 指向的是**凭据引用**，不是密钥本身；配置文件里永远不写明文密钥。

### Switching the default model

```yaml
- id: agent-default-model
  config:
    provider: codebuddy-official   # 插件提供的 CodeBuddy 路由
    # 或 my-gateway / deepseek / ...
    model: deepseek-v4.1-flash
```

### Two kinds of routes

| 路由 | 由谁提供 | 用途 |
|---|---|---|
| `codebuddy-official` | 本插件 | CodeBuddy 官方账号：官方登录态鉴权、多账号轮换、渠道校验头 |
| `codebuddy` / `my-gateway` / 其它 | 官方 `llm-pi-ai` | 任意 OpenAI 兼容端点，自己配 `baseURL` + `apiKeyEnv` |

> CodeBuddy 官方账号**不能**写成普通的 OpenAI 兼容 provider：那样会绕过官方登录态
> 鉴权，并因缺少渠道校验头被服务端拦截（错误码 `11128`）。

---

## Importing accounts

`.info` 文件即官方登录态。每个账号一个文件，可并存。

```powershell
# 复制账号文件到官方登录目录
Copy-Item C:\accounts\*.info "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\"
```

或安装时一并完成：

```powershell
.\scripts\install.ps1 -Profile qq -Accounts C:\accounts
```

**注意**：WorkBuddy 桌面端写的 `workbuddy-desktop.info` 使用 `$wbEncrypted` 加密，
其中的 token 是密文，插件会自动跳过。请使用明文的 `workbuddy-desktop-ai*.info`。

---

## How it works

```
dsh (agent loop)
  │
  ├─ llm-pi-ai (官方) ──► 手动配置的任意模型 API
  │
  └─ llm-codebuddy (本插件) ──► route: codebuddy-official
        │
        ├─ 读取官方 .info 登录文件（多账号，自动发现）
        ├─ 注入官方渠道校验头 (x-conversation-* / x-agent-* / x-ide-*)
        ├─ 首条消息补 system（官方要求）
        ├─ 403 / 11140 → 该号冷却 30 分钟 → 换号
        ├─ 401 → 刷新 token 重试 → 仍失败换号
        └─ 全部账号失效 → 换域重试 (workbuddy.ai ⇄ copilot.tencent.com)
```

### Adapter contract notes

dsh 的 LLM 适配器契约（`LlmAdapter`）要求实现：

- `providerInfo()` → `{ id, name }`（`id` 必须等于路由名）
- `listModels()` → `LlmModelInfo[]`（`provider` / `id` / `name`）
- `resolveModel()` → `LlmResolvedModelInfo`（附带 `context` / `defaultMaxTokens`）
- `prepareCall()` → `{ model, stream }`，把模型元数据与同一次 generation 的流绑定
- `stream()` → dsh 的 chunk 序列：
  `block-start(text) → text-delta* → block-end → usage → finish`

CodeBuddy 官方只接受 `stream: true`，因此非流式请求由插件内部转成流式再解析。

### 为什么需要专门的插件

CodeBuddy 的鉴权不是 API Key，而是官方客户端写入的登录态；并且服务端对请求做
**渠道校验**（错误码 `11128`「Request blocked」），要求：

- 首条消息必须是 `role: system`
- 带齐 `x-user-id` / `x-domain` / `x-product` / `x-request-id` /
  `x-conversation-id` / `x-conversation-request-id` / `x-conversation-message-id` /
  `x-agent-intent` / `x-agent-type` / `x-agent-runtime` / `x-ide-type` / `x-ide-version`
- User-Agent 形如 `CLI/<version> CodeBuddy/<version>`

这些无法用通用的 OpenAI 兼容配置表达，所以单独实现。

---

## Plugin configuration

`cordis.patch.yml`：

```yaml
- id: llm-codebuddy
  config:
    account: ''              # 固定某个账号；留空则自动轮换
    cooldownMs: 1800000      # 账号冷却时长（默认 30 分钟）
    minIntervalMs: 1200      # 相邻请求最小间隔
    userAgent: ''            # 覆盖 UA；留空用官方默认
    displayName: 'CodeBuddy'
```

---

## FAQ

**Q: 提示 `no CodeBuddy login found`**
没有找到明文 `.info` 文件。确认路径正确，且不是加密版。

**Q: 一直报 `11128 / Request blocked`**
请求没通过官方渠道校验。检查：首条消息是否为 system、请求头是否完整、
UA 是否被自定义成了非官方格式。

**Q: 报 `401`**
token 过期或该域不接受这个账号。插件会自动尝试刷新；仍失败则换域。

**Q: 想加更多账号**
直接往登录目录放更多 `.info` 文件即可，插件会自动发现。

---

## License

MIT
