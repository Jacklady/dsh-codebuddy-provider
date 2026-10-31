# dsh-codebuddy-provider

把 **CodeBuddy / WorkBuddy 官方账号**接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh），并允许你在 dsh 里**手动配置任意模型 API**。

- 多账号轮换：某个号被风控时自动冷却并切到下一个
- 域级降级：所有账号都失效时自动换域重试（风控按「域 + 账号」隔离）
- token 自动续期：临近过期时调用官方刷新接口并原子写回登录文件
- 官方协议：使用与官方 CLI 一致的请求身份与 UA，通过服务端渠道校验
- **手动配置模型 API**：任意 OpenAI 兼容端点都能在 dsh 里配，不限于 CodeBuddy

---

## 快速开始

### 1. 准备账号

两种方式，任选其一：

**方式 A：扫码登录（推荐，无需手工准备文件）**

```bash
node scripts/login.mjs
```

终端会显示二维码与授权链接，手机扫一下即可。详见「扫码登录」一节。

**方式 B：用官方客户端登录一次**

登录文件位于：

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

# 安装 + 直接进入扫码登录
.\scripts\install.ps1 -Profile qq -Login

# 卸载
.\scripts\install.ps1 -Profile qq -Uninstall
```

### 3. 验证

```bash
dsh --profile qq headless "你好"
```

---

## 手动配置模型 API

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

### 切换默认模型

```yaml
- id: agent-default-model
  config:
    provider: codebuddy-official   # 插件提供的 CodeBuddy 路由
    # 或 my-gateway / deepseek / ...
    model: deepseek-v4.1-flash
```

### 两个路由的区别

| 路由 | 由谁提供 | 用途 |
|---|---|---|
| `codebuddy-official` | 本插件 | CodeBuddy 官方账号：官方登录态鉴权、多账号轮换、渠道校验头 |
| `codebuddy` / `my-gateway` / 其它 | 官方 `llm-pi-ai` | 任意 OpenAI 兼容端点，自己配 `baseURL` + `apiKeyEnv` |

> CodeBuddy 官方账号**不能**写成普通的 OpenAI 兼容 provider：那样会绕过官方登录态
> 鉴权，并因缺少渠道校验头被服务端拦截（错误码 `11128`）。

---

## 扫码登录

不需要手工准备 `.info` 文件——直接扫码即可。

```bash
node scripts/login.mjs            # 扫码登录（默认 www.workbuddy.ai 域）
npm run login                     # 同上
```

终端会显示授权链接与二维码，用手机扫码（或用浏览器打开链接）完成授权：

```
请用手机或浏览器完成授权：
  https://www.workbuddy.ai/login?platform=workbuddy&state=xxxxxxxx

或直接扫描下方二维码：
█████████████████████████
██                       ██
██  ▄▄▄▄▄▄▄▄▄  ▄▄▄  ▄▄▄  ██
...
```

扫码确认后，凭证会按官方格式写入登录目录，插件自动发现并使用。

也可以在安装时直接进入扫码：

```powershell
.\scripts\install.ps1 -Profile qq -Login
```

### 选项

| 选项 | 说明 |
|---|---|
| `--domain <域>` | 登录域，默认 `www.workbuddy.ai`；可选 `www.codebuddy.ai` / `www.codebuddy.cn` |
| `--no-qr` | 不渲染二维码，只打印链接 |
| `--open` | 用默认浏览器打开授权页 |

### 扫码登录的原理

官方 CLI 的登录本质是「授权码换 token」，插件直接调用同一套官方接口：

```
POST /v2{prefix}/auth/state?platform=<p>   → 拿到 state 与授权页地址
        ↓ （用户在授权页完成扫码 / 账号登录）
GET  /v2{prefix}/auth/token?state=<state>  → 轮询直到返回 token
        ↓
GET  /v2/plugin/account                   → 拉取账号资料
        ↓
写入 <authDir>/workbuddy-desktop-ai.<uid>.info
```

轮询期间服务端返回 `code 11217`（`login ing...`），表示「还在等扫码确认」。

二维码由内置的**零依赖 QR 编码器**（`src/qr.js`）渲染，不引入任何 npm 依赖，
支持版本 1~10、纠错等级 L/M，容量 19~271 字节——登录链接通常在 100 字节左右。

---

## 导入账号

如果你已经有 `.info` 文件（官方客户端导出的、或别人给的），也可以直接导入：

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

## 工作原理

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

### 插件实现要点

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

## 配置项（插件自身）

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

## 常见问题

**Q: 提示 `no CodeBuddy login found`**
没有找到明文 `.info` 文件。确认路径正确，且不是加密版。

**Q: 一直报 `11128 / Request blocked`**
请求没通过官方渠道校验。检查：首条消息是否为 system、请求头是否完整、
UA 是否被自定义成了非官方格式。

**Q: 报 `401`**
token 过期或该域不接受这个账号。插件会自动尝试刷新；仍失败则换域。

**Q: 想加更多账号**
直接往登录目录放更多 `.info` 文件即可，插件会自动发现。也可以再跑一次 `node scripts/login.mjs`
扫码加号。

**Q: 扫码时提示 `login timed out`**
二维码在 5 分钟内没有完成确认。重新跑一次 `node scripts/login.mjs` 即可。

**Q: 二维码扫不出来**
终端可能不支持 `▀▄` 半块字符（老版本 Windows 控制台常见）。加 `--no-qr`
只打印链接，用手机浏览器打开；或者换一个支持 UTF-8 的终端。

---

## 许可

MIT
