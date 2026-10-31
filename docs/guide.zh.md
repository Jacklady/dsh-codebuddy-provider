# 操作教程

面向使用者的完整上手指南。README 是速查表，本文是手把手教程。

---

## 目录

- [0. 前置条件](#0-前置条件)
- [1. 场景一：从零开始（最快路径）](#1-场景一从零开始最快路径)
- [2. 场景二：已有 `.info` 文件](#2-场景二已有-info-文件)
- [3. 场景三：配置第三方模型 API](#3-场景三配置第三方模型-api)
- [4. 场景四：服务器 / 无图形界面环境](#4-场景四服务器--无图形界面环境)
- [5. 多账号管理](#5-多账号管理)
- [6. 故障排查](#6-故障排查)
- [7. 命令速查表](#7-命令速查表)
- [8. 卸载与回滚](#8-卸载与回滚)

---

## 0. 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（实测 22.x） | dsh 本身就跑在 Node 上 |
| DeepSeek Harness | 0.2.1-rc.2 | `dsh --version` 能输出即可 |
| Python | ≥ 3.10 | 仅 dsh 的部分 bundle 需要 |
| 一个 CodeBuddy / WorkBuddy 账号 | — | 扫码登录或从官方客户端导出 |

检查环境：

```bash
node --version
dsh --version
```

**目录约定**（下文的路径都基于这些）：

| 用途 | Windows | macOS | Linux |
|---|---|---|---|
| dsh 根目录 | `%USERPROFILE%\.dsh` | `~/.dsh` | `~/.dsh` |
| profile 目录 | `%USERPROFILE%\.dsh\profiles\<名字>` | 同左 | 同左 |
| 登录态目录 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth` | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth` | `$XDG_DATA_HOME/CodeBuddyExtension/Data/Public/auth` |

> 登录态目录里的 `.info` 文件就是账号凭证。**不要把它提交到 git，也不要公开分享。**

---

## 1. 场景一：从零开始（最快路径）

全程约 3 分钟，其中大部分时间在等你扫码。

### 步骤 1 — 克隆仓库

```bash
git clone https://github.com/Jacklady/dsh-codebuddy-provider.git
cd dsh-codebuddy-provider
```

### 步骤 2 — 扫码登录

```bash
node scripts/login.mjs
```

预期输出：

```
正在发起登录请求…

请用手机或浏览器完成授权：
  https://www.workbuddy.ai/login?platform=workbuddy&state=9720b3a6-ac74-47df-81e3-86331f164060

或直接扫描下方二维码：
██████████████████████████
██                        ██
██  ▄▄▄▄▄▄▄▄▄▄  ▄▄▄  ▄▄▄  ██
██                        ██
██████████████████████████

  等待扫码确认… 2s (login ing...)
  等待扫码确认… 4s (login ing...)
```

**你要做的**：手机扫终端里的二维码 → 打开官方授权页 → 用微信/QQ 扫码确认。

确认成功后：

```
登录成功。
  账号: 2246602038  (450701813596)
  域:   www.workbuddy.ai
  文件: C:\Users\<你>\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.<uid>.info

当前可用账号（1 个）：
  - 2246602038  [www.workbuddy.ai]  workbuddy-desktop-ai.<uid>.info
```

**二维码扫不出来？** 加 `--no-qr` 只打印链接，用手机浏览器打开：

```bash
node scripts/login.mjs --no-qr
```

### 步骤 3 — 安装到 dsh profile

```powershell
# Windows
.\scripts\install.ps1 -Profile qq
```

```bash
# macOS / Linux
# install.ps1 是 PowerShell 脚本；Linux/macOS 可手动执行等价步骤，见文末说明
```

预期输出：

```
==> Installing dsh-codebuddy-provider into profile 'qq'
    plugin copied to C:\Users\<你>\.dsh\profiles\qq\node_modules\dsh-codebuddy-provider
    package.json updated
    CodeBuddy provider block appended to cordis.patch.yml
==> Validating profile configuration
    configuration parses cleanly
==> Done
```

> **看到 `configuration parses cleanly` 就说明装好了。**
> 如果这里报错，看 [故障排查](#6-故障排查) 的第 1 条。

### 步骤 4 — 把默认模型切到 CodeBuddy

```powershell
.\scripts\install.ps1 -Profile qq -Enable
```

或者手动在 `<profile>/cordis.patch.yml` 里加：

```yaml
- id: agent-default-model
  config:
    provider: codebuddy-official
    model: deepseek-v4.1-flash
```

### 步骤 5 — 验证

```bash
dsh --profile qq headless "你好"
```

预期输出 `你好`（或模型的正常回复）。

再确认模型目录已加载：

```bash
dsh --profile qq --dump-config | grep -A 3 codebuddy
```

---

## 2. 场景二：已有 `.info` 文件

如果你手上有官方客户端导出的 `.info` 文件（或者别人给的），可以跳过扫码。

### 复制到登录态目录

**Windows**

```powershell
Copy-Item C:\path\to\*.info "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\"
```

**macOS**

```bash
cp /path/to/*.info ~/Library/Application\ Support/CodeBuddyExtension/Data/Public/auth/
```

**Linux**

```bash
cp /path/to/*.info ~/.local/share/CodeBuddyExtension/Data/Public/auth/
```

或者安装时一并完成：

```powershell
.\scripts\install.ps1 -Profile qq -Accounts C:\path\to\accounts
```

### ⚠️ 加密文件不通用

WorkBuddy 桌面端写的 `workbuddy-desktop.info` 使用 `$wbEncrypted` 加密存储，里面的
token 是密文。**插件会自动跳过它**，请使用明文的 `workbuddy-desktop-ai*.info`。

判断方法：

```bash
# 明文文件长这样（有 accessToken 明文字符串）
head -c 200 workbuddy-desktop-ai.<uid>.info

# 加密文件长这样（$wbEncrypted）
head -c 200 workbuddy-desktop.info
```

---

## 3. 场景三：配置第三方模型 API

本插件**不实现**通用 provider——那是官方 `llm-pi-ai` 的能力。所以任意 OpenAI 兼容
端点都直接在 dsh 里配，插件不参与。

编辑 `<profile>/cordis.patch.yml`：

```yaml
- id: llm-pi-ai
  config:
    providers:
      # CodeBuddy 官方账号由插件提供，不要在这里重复声明 codebuddy，
      # 否则两个 provider 会抢同一个路由名导致启动报错。
      my-gateway:
        displayName: My Gateway
        api: openai-completions
        baseURL: https://api.example.com/v1
        apiKeyEnv: MY_GATEWAY_KEY
        models:
          - id: qwen-max
            contextWindow: 128000
            maxTokens: 8000

- id: agent-default-model
  config:
    provider: my-gateway
    model: qwen-max
```

### 密钥放哪

`apiKeyEnv` 指向的是**凭据引用**，不是密钥本身。两种做法：

**做法 A：用 dsh 的凭据服务（推荐）**

在 dsh 的 Models 页面里把 API Key 存进凭据服务，然后 `apiKeyEnv` 填凭据名。

**做法 B：环境变量**

```bash
export MY_GATEWAY_KEY="sk-xxxx"
dsh --profile qq headless "你好"
```

> 配置文件里永远不要写明文密钥。

### 两种路由的区别

| 路由名 | 由谁提供 | 用途 |
|---|---|---|
| `codebuddy-official` | 本插件 | CodeBuddy 官方账号：登录态鉴权、多账号轮换、渠道校验头 |
| `my-gateway` / `deepseek` / 其它 | 官方 `llm-pi-ai` | 任意 OpenAI 兼容端点，自己配 `baseURL` + `apiKeyEnv` |

---

## 4. 场景四：服务器 / 无图形界面环境

服务器上跑 dsh 常见问题：**SSH 断开后子进程被杀**。必须用计划任务（或 systemd）托管。

### 4.1 目录权限

登录态目录属于登录用户。如果用 `SYSTEM` 账户跑任务，`%LOCALAPPDATA%` 会指向
`C:\Windows\System32\config\systemprofile\...`，**找不到账号文件**。

三种解法，任选其一：

**解法 A：用 Administrator 账户跑任务（最简单）**

```powershell
$prn = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType S4U -RunLevel Highest
```

**解法 B：在启动脚本里显式覆盖环境变量**

```bat
@echo off
set "LOCALAPPDATA=C:\Users\Administrator\AppData\Local"
set "USERPROFILE=C:\Users\Administrator"
set "CB_AUTH_DIR=C:\Users\Administrator\AppData\Local\CodeBuddyExtension\Data\Public\auth"
```

> `CB_AUTH_DIR` 是本插件支持的环境变量，优先级最高，多个目录用 `;` 分隔。

**解法 C：跑在 Administrator 交互登录态下**

### 4.2 用计划任务常驻

```powershell
$bat = 'C:\Users\Administrator\qqbot\bridge\start-dsh.bat'
$act = New-ScheduledTaskAction -Execute $bat -WorkingDirectory (Split-Path $bat)
$trg = New-ScheduledTaskTrigger -AtStartup
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
       -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
       -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$prn = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName 'dsh-qq' -Action $act -Trigger $trg -Settings $set -Principal $prn -Force
Start-ScheduledTask -TaskName 'dsh-qq'
```

### 4.3 扫码登录在服务器上怎么操作

服务器没有显示器，二维码渲染在 SSH 终端里。两种做法：

**做法 A：用 SSH 客户端的终端渲染**

直接 SSH 上去跑 `node scripts/login.mjs`，终端会画出二维码。手机扫屏幕即可。

**做法 B：只要链接**

```bash
node scripts/login.mjs --no-qr
```

把打印出来的链接发到手机上打开。

> ⚠️ **二维码里含有一次性授权凭据**。虽然是短时效的 `state`，仍建议用完即弃，不要截图发群里。

### 4.4 Linux / macOS

`install.ps1` 是 PowerShell 脚本。Linux/macOS 上手动执行等价步骤：

```bash
PROFILE_DIR=~/.dsh/profiles/qq
PLUGIN_DIR=$PROFILE_DIR/node_modules/dsh-codebuddy-provider

# 1) 复制插件
mkdir -p "$PLUGIN_DIR"
cp -r src scripts templates cordis.patch.yml package.json "$PLUGIN_DIR/"

# 2) 登记依赖与 bundle（用 node 编辑，避免手改 JSON 出错）
node scripts/edit-package-json.mjs "$PROFILE_DIR/package.json" \
     dsh-codebuddy-provider dsh-codebuddy-provider 'file:./node_modules/dsh-codebuddy-provider'

# 3) 合并 provider 配置
node scripts/merge-patch.mjs "$PROFILE_DIR" templates/codebuddy-provider.yml

# 4) 校验
dsh --profile qq --dump-config
```

---

## 5. 多账号管理

### 加账号

```bash
node scripts/login.mjs        # 扫一次加一个
```

每个账号一个 `.info` 文件，放在登录态目录里。

### 查看当前账号

```bash
node -e "
import('./src/credentials.js').then(async m => {
  for (const a of await m.listAccounts()) {
    console.log(a.nickname, a.domain, a.expired ? '(expired)' : '');
  }
});
"
```

### 轮换与冷却

插件默认自动轮换：

- 账号返回 **403 / 11140**（账号级风控）→ 该号冷却 **30 分钟** → 自动切下一个
- 账号返回 **401**（token 失效）→ 先刷新 token 重试 → 仍失败则换号
- 所有账号都失效 → 换域重试（`workbuddy.ai` ⇄ `copilot.tencent.com`）

调整参数（`<profile>/cordis.patch.yml`）：

```yaml
- id: llm-codebuddy
  config:
    account: ''              # 钉死某个账号（uid 或 .info 文件名片段）；留空 = 自动轮换
    cooldownMs: 1800000      # 冷却时长，默认 30 分钟
    minIntervalMs: 1200      # 相邻请求最小间隔，默认 1.2 秒
    userAgent: ''            # 覆盖 UA；留空用官方默认
    displayName: 'CodeBuddy'
```

> `minIntervalMs` 建议不要调低于 1200。服务端对高频请求有风控，
> 上限被触发后会返回 `14003 模型繁忙`，进而可能升级为账号级限制。

### 删除账号

删掉对应的 `.info` 文件即可：

```bash
rm "$LOCALAPPDATA/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.<uid>.info"
```

---

## 6. 故障排查

### 1. 安装时报 `configuration reported problems`

| 现象 | 原因 | 处理 |
|---|---|---|
| `llm-pi-ai not found` | profile 里没装官方 bundle | profile 的 `package.json` 的 `dsh.profile.bundles` 里要有 `@deepseek-ai/dsh-base` |
| `patch: entry not found` | profile 里没装这个插件 | 先 `dsh plugin --profile <名字> add <包>`，或跑一次 `install.ps1` |
| `must be a top-level YAML array` | `cordis.patch.yml` 被改坏 | 恢复成数组格式（顶层以 `- id:` 开头） |

诊断命令：

```bash
dsh --profile qq --dump-config
```

### 2. 运行时提示 `no CodeBuddy login found`

登录态目录里没有**明文** `.info` 文件。检查：

```bash
ls "$LOCALAPPDATA/CodeBuddyExtension/Data/Public/auth/"
```

- 文件在但没被识别 → 是加密版（`workbuddy-desktop.info`），插件会跳过
- 文件不在 → 路径不对，用 `CB_AUTH_DIR` 显式指定

### 3. 报 `11128 / Request blocked`

请求没通过官方渠道校验。自查三点：

1. 首条消息是不是 `role: system`（插件会自动补，但如果你在 `cordis.patch.yml`
   里改了 `system-prompt` 的 `personaPrefix` 要注意）
2. UA 是不是被自定义成了非官方格式（别改 `userAgent`，除非你确认过）
3. `x-product: SaaS`、`x-domain`、`x-user-id` 是否齐全

### 4. 报 `401`

token 过期，或该域不接受这个账号。插件会自动尝试刷新；仍失败则换域。

手工排查：

```bash
node -e "
import('./src/credentials.js').then(async m => {
  const c = await m.openCredentialManager();
  console.log(await c.summary());
});
"
```

### 5. 二维码扫不出来

终端不支持 `▀▄` 半块字符（老版本 Windows 控制台常见）。解决：

```bash
node scripts/login.mjs --no-qr     # 只打印链接
```

或者换支持 UTF-8 的终端（Windows Terminal、VS Code 终端、macOS/iTerm）。

### 6. 扫码一直不成功

服务端在等你确认时返回 `code 11217`（`login ing...`）。如果一直不变：

- 二维码已过期 → 重新跑一次
- 扫码后没在授权页点「确认」→ 微信/QQ 扫码后还要在手机上点一次确认
- 用了错误的域 → 试试 `--domain www.codebuddy.ai`

### 7. 服务重启后没了

SSH 断开导致子进程被回收。用计划任务托管（见 [4.2](#42-用计划任务常驻)）。

### 8. 账号被风控了（`11140`）

服务端返回「账号存在异常行为，已被限制使用」。处理：

1. 插件会自动冷却并换号，检查 `listAccounts` 里是否还有可用账号
2. 被封的账号可以尝试申诉（错误码里带 `SUBMIT_FEEDBACK` 动作）
3. 降低请求频率：`minIntervalMs` 调到 2000 以上
4. 用 `--domain` 换到另一个域的账号

---

## 7. 命令速查表

### 安装脚本

```powershell
.\scripts\install.ps1 -Profile <名字>                    # 安装
.\scripts\install.ps1 -Profile <名字> -Accounts <目录>    # 安装 + 导入 .info
.\scripts\install.ps1 -Profile <名字> -Enable             # 安装 + 切默认模型
.\scripts\install.ps1 -Profile <名字> -Login              # 安装 + 直接扫码登录
.\scripts\install.ps1 -Profile <名字> -Login -LoginDomain www.codebuddy.ai
.\scripts\install.ps1 -Profile <名字> -Force              # 覆盖已有 provider 配置
.\scripts\install.ps1 -Profile <名字> -Uninstall          # 卸载
```

### 扫码登录

```bash
node scripts/login.mjs                        # 默认域
node scripts/login.mjs --domain www.codebuddy.ai
node scripts/login.mjs --no-qr                # 只打印链接
node scripts/login.mjs --open                 # 同时打开浏览器
```

### dsh

```bash
dsh --profile <名字> headless "任务"          # 跑一次
dsh --profile <名字> --dump-config            # 看配置树
dsh --profile <名字> --dump-config-schema     # 看 patch 的 schema
dsh plugin --profile <名字> add <包>          # 装插件
dsh plugin --profile <名字> remove <包>       # 卸插件
```

### 插件 API

```javascript
import {
  login, startLogin, waitForToken, fetchAccount, writeAccountFile,
  listAccounts, findAuthFiles, openCredentialManager,
  CodeBuddyProvider, encodeQr, qrToTerminal,
} from 'dsh-codebuddy-provider';
```

---

## 8. 卸载与回滚

### 卸载插件

```powershell
.\scripts\install.ps1 -Profile qq -Uninstall
```

这会：删除 `node_modules/dsh-codebuddy-provider`、从 `package.json` 移除依赖与
bundle 声明。

> `cordis.patch.yml` 里注入的 provider 片段**会保留**（避免误删用户自己的配置）。
> 想彻底清掉就手动删掉那段 `- id: llm-pi-ai` 里的 `providers:` 部分。

### 保留账号

卸载插件**不会**删除登录态目录里的 `.info` 文件。账号凭证独立于插件存在，
重新装上就能继续用。

### 回滚到某个提交

```bash
git log --oneline
git checkout <commit-sha>
```

---

## 附：环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `CB_AUTH_DIR` | 登录态目录（`;` 分隔多个） | 按平台推导 |
| `CB_CLI_VERSION` | 覆盖 UA 里的 CLI 版本号 | 自动探测本机版本 |
| `DSH_HOME` | dsh 根目录 | `~/.dsh` |

---

有问题先看 [故障排查](#6-故障排查)，里面覆盖了 8 类常见情况。
