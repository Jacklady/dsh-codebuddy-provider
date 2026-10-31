# dsh-codebuddy-provider

> Chinese documentation: [README.zh.md](./README.zh.md)

Connects **official CodeBuddy / WorkBuddy accounts** to [DeepSeek Harness](https://github.com/deepseek-ai/dsh), and lets you configure any model API manually inside dsh.

- Multi-account rotation: an account hit by risk control is cooled down and the next one takes over
- Domain fallback: when every account fails, the request is retried against the other domain (risk control is isolated per domain + account)
- Automatic token renewal: the official refresh endpoint is called shortly before expiry and the login file is written back atomically
- Official protocol: the request identity and User-Agent match the official CLI, passing the server-side channel check
- **Manual model API configuration**: any OpenAI-compatible endpoint can be configured in dsh, not just CodeBuddy

---

## Quick Start

### 1. Get an account

Two options, pick either one:

**Option A: QR-code login (recommended, no manual file needed)**

```bash
node scripts/login.mjs
```

The terminal prints a QR code and the authorization URL - just scan it. See "QR-code login" below.

**Option B: sign in once with the official client**

The login file lives at:

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info` |
| Linux | `$XDG_DATA_HOME/CodeBuddyExtension/Data/Public/auth/*.info` |

> You can also import `.info` files from elsewhere (see "Importing accounts" below).

### 2. Install

```powershell
# install into the given profile
.\scripts\install.ps1 -Profile qq

# install + import accounts + set as default model
.\scripts\install.ps1 -Profile qq -Accounts C:\path\to\accounts -Enable

# install + start the QR-code login right away
.\scripts\install.ps1 -Profile qq -Login

# uninstall
.\scripts\install.ps1 -Profile qq -Uninstall
```

### 3. Verify

```bash
dsh --profile qq headless "hello"
```

---

## Configuring model APIs manually

This plugin does **not** reimplement the generic provider - that part is provided by the official `@deepseek-ai/dsh-llm-pi-ai`.
You can declare any OpenAI-compatible endpoint in the dsh `cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      # any OpenAI-compatible API - handled by the official seam, no plugin needed
      my-gateway:
        displayName: My Gateway
        api: openai-completions
        baseURL: https://api.example.com/v1
        apiKeyEnv: MY_GATEWAY_KEY
        models:
          - id: qwen-max
            contextWindow: 128000
            maxTokens: 8000

      # official DeepSeek
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

Then store the API key in the credential service from dsh's Models page, or export it as an environment variable
`MY_GATEWAY_KEY` / `DEEPSEEK_API_KEY`。

> `apiKeyEnv` points at a **credential reference**, not the key itself; never put a plaintext key in the config file.

### Switching the default model

```yaml
- id: agent-default-model
  config:
    provider: codebuddy-official   # the CodeBuddy route provided by this plugin
    # or my-gateway / deepseek / ...
    model: deepseek-v4.1-flash
```

### Two kinds of routes

| Route | Provided by | Purpose |
|---|---|---|
| `codebuddy-official` | this plugin | Official CodeBuddy accounts: login-state auth, multi-account rotation, channel-check headers |
| `codebuddy` / `my-gateway` / others | official `llm-pi-ai` | Any OpenAI-compatible endpoint; configure `baseURL` + `apiKeyEnv` yourself |

> The official CodeBuddy account **cannot** be expressed as a plain OpenAI-compatible provider:/n> that would bypass the official login-state authentication and the request would be rejected by
> the server for missing the channel-check headers (error code `11128`).

---

## QR-code login

No need to prepare `.info` files by hand - just scan the code.

```bash
node scripts/login.mjs            # QR login (defaults to the www.workbuddy.ai domain)
npm run login                     # same thing
```

The terminal prints the authorization URL and a QR code. Scan it with your phone (or open the URL in a browser):

```
Complete the authorization with your phone or a browser:
  https://www.workbuddy.ai/login?platform=workbuddy&state=xxxxxxxx

Or scan the code below:
█████████████████████████
██                       ██
██  ▄▄▄▄▄▄▄▄▄  ▄▄▄  ▄▄▄  ██
...
```

Once confirmed, the credential is written to the official login directory in the official format, and the plugin picks it up automatically.

You can also start the QR login right after installing:

```powershell
.\scripts\install.ps1 -Profile qq -Login
```

### Options

| Option | Description |
|---|---|
| `--domain <domain>` | Login domain, default `www.workbuddy.ai`; options: `www.codebuddy.ai` / `www.codebuddy.cn` |
| `--no-qr` | Do not render the QR code, only print the link |
| `--open` | Open the authorization page in the default browser |

### How the QR-code login works

The official CLI login is essentially an authorization-code-for-token exchange. The plugin calls the very same official endpoints:

```
POST /v2{prefix}/auth/state?platform=<p>   -> get the state and the authorization URL
        | (the user scans the code / signs in on the authorization page)
GET  /v2{prefix}/auth/token?state=<state>  -> poll until the token comes back
        ↓
GET  /v2/plugin/account                   -> fetch the account profile
        ↓
write <authDir>/workbuddy-desktop-ai.<uid>.info
```

While polling, the server returns `code 11217`（`login ing...`），meaning "still waiting for the scan to be confirmed".

The QR code is produced by the built-in **dependency-free QR encoder** (`src/qr.js`) - it pulls in no
It supports versions 1-10 with EC levels L/M (19-271 bytes) - an authorization URL is usually around 100 bytes.

---

## Importing accounts

If you already have `.info` files (exported by the official client, or given to you), you can import them directly:

```powershell
# copy the account files into the official login directory
Copy-Item C:\accounts\*.info "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\"
```

Or do it as part of the installation:

```powershell
.\scripts\install.ps1 -Profile qq -Accounts C:\accounts
```

**Note**: the `workbuddy-desktop.info` written by the WorkBuddy desktop client uses `workbuddy-desktop.info`  `$wbEncrypted` 
encrypted storage, so its token is ciphertext and the plugin skips it automatically. Use the plaintext `workbuddy-desktop-ai*.info`。

---

## How it works

```
dsh (agent loop)
  │
  ├─ llm-pi-ai (official) ──► any model API you configured manually
  │
  └─ llm-codebuddy (this plugin) ──► route: codebuddy-official
        │
        ├─ read the official .info login files (multi-account, auto-discovered)
        ├─ inject the official channel-check headers (x-conversation-* / x-agent-* / x-ide-*)
        ├─ prepend the first message with system (required by the official backend)
        ├─ 403 / 11140 -> cool down that account for 30 minutes -> switch to the next one
        ├─ 401 -> refresh the token and retry -> switch accounts if it still fails
        └─ every account failed -> retry against the other domain (workbuddy.ai ⇄ copilot.tencent.com)
```

### Adapter contract notes

The dsh LLM adapter contract (`LlmAdapter`) requires implementing:

- `providerInfo()` -> `{ id, name }` (`id` must equal the route name)
- `listModels()` → `LlmModelInfo[]`（`provider` / `id` / `name`）
- `resolveModel()` -> `LlmResolvedModelInfo` (with `context` / `defaultMaxTokens`)
- `prepareCall()` -> `{ model, stream }`, binding the model metadata to the stream of the same generation
- `stream()` -> the dsh chunk sequence:
  `block-start(text) → text-delta* → block-end → usage → finish`

The official CodeBuddy backend only accepts `stream: true`, so the plugin turns non-streaming
requests into a stream internally and parses them back.

### Why a dedicated plugin is needed

CodeBuddy authentication is not an API key but the login state written by the official client.
The server also performs a **channel check** on every request (error code `11128`
"Request blocked"), which requires:

- the first message must be `role: system`
- the full header set `x-user-id` / `x-domain` / `x-product` / `x-request-id` /
  `x-conversation-id` / `x-conversation-request-id` / `x-conversation-message-id` /
  `x-agent-intent` / `x-agent-type` / `x-agent-runtime` / `x-ide-type` / `x-ide-version`
- a User-Agent shaped like `CLI/<version> CodeBuddy/<version>`

None of this can be expressed with a generic OpenAI-compatible config, so it is implemented separately.

---

## Plugin configuration

`cordis.patch.yml`：

```yaml
- id: llm-codebuddy
  config:
    account: ''              # pin a specific account; empty means automatic rotation
    cooldownMs: 1800000      # account cooldown (30 minutes by default)
    minIntervalMs: 1200      # minimum interval between adjacent requests
    userAgent: ''            # override the UA; empty uses the official default
    displayName: 'CodeBuddy'
```

---

## FAQ

**Q: It says `no CodeBuddy login found`**
No plaintext `.info` file was found. Check the path, and make sure it is not the encrypted variant.

**Q: It keeps reporting `11128 / Request blocked`**
The request failed the official channel check. Verify that the first message is a system message,
that all headers are present, and that the UA was not overridden to a non-official format.

**Q: It reports `401`**
The token expired, or the domain does not accept this account. The plugin tries to refresh it
automatically and falls back to the other domain if that fails.

**Q: How do I add more accounts?**
Just drop more `.info` files into the login directory - the plugin discovers them automatically.
You can also run `node scripts/login.mjs` again to add an account by QR code.

**Q: The QR login says `login timed out`**
The code was not confirmed within 5 minutes. Just run `node scripts/login.mjs` again.

**Q: The QR code does not scan**
The terminal may not support the `▀▄` half-block characters (common on older Windows consoles).
Use `--no-qr` to print the link only and open it on your phone, or switch to a UTF-8 capable terminal.

---

## License

MIT
