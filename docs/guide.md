# User Guide

A complete walkthrough for users. The README is the cheat sheet; this is the step-by-step guide.

---

## Table of contents

- [0. Prerequisites](#0-prerequisites)
- [1. Scenario 1: start from scratch](#1-scenario-1-start-from-scratch)
- [2. Scenario 2: you already have `.info` files](#2-scenario-2-you-already-have-info-files)
- [3. Scenario 3: configure a third-party model API](#3-scenario-3-configure-a-third-party-model-api)
- [4. Scenario 4: servers / headless environments](#4-scenario-4-servers--headless-environments)
- [5. Managing multiple accounts](#5-managing-multiple-accounts)
- [6. Troubleshooting](#6-troubleshooting)
- [7. Command reference](#7-command-reference)
- [8. Uninstall and rollback](#8-uninstall-and-rollback)

---

## 0. Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| Node.js | >= 20 (22.x tested) | dsh itself runs on Node |
| DeepSeek Harness | 0.2.1-rc.2 | `dssh --version` should print |
| Python | >= 3.10 | only needed by some dsh bundles |
| A CodeBuddy / WorkBuddy account | - | scan it in, or export from the official client |

Check your environment:

```bash
node --version
dsh --version
```

**Directory conventions** (all paths below are based on these):

| Purpose | Windows | macOS | Linux |
|---|---|---|---|
| dsh home | `%USERPROFILE%\.dsh` | `~/.dsh` | `~/.dsh` |
| profile dir | `%USERPROFILE%\.dsh\profiles\<name>` | same | same |
| login dir | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth` | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth` | `$XDG_DATA_HOME/CodeBuddyExtension/Data/Public/auth` |

> The `.info` files in the login directory **are** the account credentials.
> Never commit them to git and never share them publicly.

---

## 1. Scenario 1: start from scratch

Takes about 3 minutes, most of it waiting for you to scan.

### Step 1 - clone the repository

```bash
git clone https://github.com/Jacklady/dsh-codebuddy-provider.git
cd dsh-codebuddy-provider
```

### Step 2 - QR-code login

```bash
node scripts/login.mjs
```

Expected output:

```
Starting the login request...

Complete the authorization with your phone or a browser:
  https://www.workbuddy.ai/login?platform=workbuddy&state=9720b3a6-ac74-47df-81e3-86331f164060

Or scan the code below:
██████████████████████████
██                        ██
██  ▄▄▄▄▄▄▄▄▄▄  ▄▄▄  ▄▄▄  ██
██                        ██
██████████████████████████

  Waiting for the scan to be confirmed... 2s (login ing...)
  Waiting for the scan to be confirmed... 4s (login ing...)
```

**What to do**: scan the code with your phone -> open the official authorization page ->
confirm with WeChat / QQ.

Once confirmed:

```
Login succeeded.
  Account: 2246602038  (450701813596)
  Domain: www.workbuddy.ai
  File:   C:\Users\<you>\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.<uid>.info

Available accounts (1):
  - 2246602038  [www.workbuddy.ai]  workbuddy-desktop-ai.<uid>.info
```

**Cannot scan the code?** Use `--no-qr` to print the link only and open it on your phone:

```bash
node scripts/login.mjs --no-qr
```

### Step 3 - install into the dsh profile

```powershell
# Windows
.\scripts\install.ps1 -Profile qq
```

```bash
# macOS / Linux
# install.ps1 is a PowerShell script; on Linux/macOS run the equivalent steps manually
```

Expected output:

```
==> Installing dsh-codebuddy-provider into profile 'qq'
    plugin copied to C:\Users\<you>\.dsh\profiles\qq\node_modules\dsh-codebuddy-provider
    package.json updated
    CodeBuddy provider block appended to cordis.patch.yml
==> Validating profile configuration
    configuration parses cleanly
==> Done
```

> **Seeing `configuration parses cleanly` means the install succeeded.**
> If it reports a problem, check [Troubleshooting](#6-troubleshooting) item 1.

### Step 4 - switch the default model to CodeBuddy

```powershell
.\scripts\install.ps1 -Profile qq -Enable
```

Or add it by hand in `<profile>/cordis.patch.yml`:

```yaml
- id: agent-default-model
  config:
    provider: codebuddy-official
    model: deepseek-v4.1-flash
```

### Step 5 - verify

```bash
dsh --profile qq headless "hello"
```

You should get `hello` (or whatever the model replies).

Then confirm the model catalog is loaded:

```bash
dsh --profile qq --dump-config | grep -A 3 codebuddy
```

---

## 2. Scenario 2: you already have `.info` files

If you already have `.info` files (exported by the official client, or given to you), you
can skip the QR login.

### Copy them into the login directory

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

Or do it as part of the installation:

```powershell
.\scripts\install.ps1 -Profile qq -Accounts C:\path\to\accounts
```

### Encrypted files do not work

The `workbuddy-desktop.info` written by the WorkBuddy desktop client uses `$wbEncrypted`
storage, so its token is ciphertext. **The plugin skips it automatically** - use the
plaintext `workbuddy-desktop-ai*.info` files instead.

How to tell them apart:

```bash
# a plaintext file looks like this (accessToken is readable)
head -c 200 workbuddy-desktop-ai.<uid>.info

# an encrypted file looks like this ($wbEncrypted)
head -c 200 workbuddy-desktop.info
```

---

## 3. Scenario 3: configure a third-party model API

This plugin does **not** implement the generic provider - that is the job of the official
`llm-pi-ai`. So any OpenAI-compatible endpoint is configured directly in dsh; the plugin
stays out of the way.

Edit `<profile>/cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      # The CodeBuddy official account is provided by the plugin - do not declare a
      # 'codebuddy' provider here, or both would claim the same route name.
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

### Where the key goes

`apiKeyEnv` points at a **credential reference**, not the key itself. Two ways to do it:

**Option A: the dsh credential service (recommended)**

Store the API key in the credential service from dsh's Models page, then use the
credential name in `apiKeyEnv`.

**Option B: an environment variable**

```bash
export MY_GATEWAY_KEY="sk-xxxx"
dsh --profile qq headless "hello"
```

> Never put a plaintext key in the config file.

### Two kinds of routes

| Route | Provided by | Purpose |
|---|---|---|
| `codebuddy-official` | this plugin | Official CodeBuddy accounts: login-state auth,
multi-account rotation, channel-check headers |
| `my-gateway` / `deepseek` / others | official `llm-pi-ai` | Any OpenAI-compatible endpoint;
configure `baseURL` + `apiKeyEnv` yourself |

---

## 4. Scenario 4: servers / headless environments

The classic problem on a server: **the child process is killed when the SSH session ends**.
You need a scheduled task (or a systemd unit) to keep it alive.

### 4.1 Path permissions

The login directory belongs to the logged-in user. If the task runs as `SYSTEM`,
`%LOCALAPPDATA%` points at `C:\Windows\System32\config\systemprofile\...` and the
**account files will not be found**.

Three ways out, pick one:

**Option A: run the task as Administrator (simplest)**

```powershell
$prn = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType S4U -RunLevel Highest
```

**Option B: override the environment in the launcher script**

```bat
@echo off
set "LOCALAPPDATA=C:\Users\Administrator\AppData\Local"
set "USERPROFILE=C:\Users\Administrator"
set "CB_AUTH_DIR=C:\Users\Administrator\AppData\Local\CodeBuddyExtension\Data\Public\auth"
```

> `CB_AUTH_DIR` is an environment variable supported by this plugin. It takes precedence,
and multiple directories are separated with `;`.

**Option C: run it under an interactive Administrator session**

### 4.2 Keep it alive with a scheduled task

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

### 4.3 Doing the QR login on a server

The server has no display, so the QR code is rendered in your SSH terminal. Two ways:

**Option A: render it in your SSH terminal**

SSH in and run `node scripts/login.mjs`. The terminal draws the code - point your phone at it.

**Option B: just take the link**

```bash
node scripts/login.mjs --no-qr
```

Send the printed link to your phone and open it there.

> **The QR code carries a one-time authorization credential.** The `state` is short-lived,
> but still treat it as disposable and do not post screenshots of it in chat groups.

### 4.4 Linux / macOS

`install.ps1` is a PowerShell script. On Linux/macOS, run the equivalent steps by hand:

```bash
PROFILE_DIR=~/.dsh/profiles/qq
PLUGIN_DIR=$PROFILE_DIR/node_modules/dsh-codebuddy-provider

# 1) copy the plugin
mkdir -p "$PLUGIN_DIR"
cp -r src scripts templates cordis.patch.yml package.json "$PLUGIN_DIR/"

# 2) register the dependency and bundle (edit via node to avoid hand-editing JSON)
node scripts/edit-package-json.mjs "$PROFILE_DIR/package.json" \
     dsh-codebuddy-provider dsh-codebuddy-provider 'file:./node_modules/dsh-codebuddy-provider'

# 3) merge the provider config
node scripts/merge-patch.mjs "$PROFILE_DIR" templates/codebuddy-provider.yml

# 4) validate
dsh --profile qq --dump-config
```

---

## 5. Managing multiple accounts

### Adding accounts

```bash
node scripts/login.mjs        # scan once per account
```

Each account gets its own `.info` file in the login directory.

### Listing the current accounts

```bash
node -e "
import('./src/credentials.js').then(async m => {
  for (const a of await m.listAccounts()) {
    console.log(a.nickname, a.domain, a.expired ? '(expired)' : '');
  }
});
"
```

### Rotation and cooldown

The plugin rotates automatically by default:

- **403 / 11140** (account-level risk control) -> cool that account down for **30 minutes**
  -> switch to the next one
- **401** (token invalid) -> refresh the token and retry -> switch accounts if it still fails
- every account failed -> retry against the other domain
  (`workbuddy.ai` <-> `copilot.tencent.com`)

Tune it (`<profile>/cordis.patch.yml`):

```yaml
- id: llm-codebuddy
  config:
    account: ''              # pin an account (uid or .info filename fragment); empty = rotate
    cooldownMs: 1800000      # cooldown, 30 minutes by default
    minIntervalMs: 1200      # minimum gap between adjacent requests, 1.2s by default
    userAgent: ''            # override the UA; empty uses the official default
    displayName: 'CodeBuddy'
```

> Keep `minIntervalMs` at or above 1200. The server applies risk control to high request
> rates; once the quota is hit it returns `14003` (model busy), which can escalate into an
> account-level restriction.

### Removing an account

Just delete the corresponding `.info` file:

```bash
rm "$LOCALAPPDATA/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.<uid>.info"
```

---

## 6. Troubleshooting

### 1. The install reports `configuration reported problems`

| Symptom | Cause | Fix |
|---|---|---|
| `llm-pi-ai not found` | the official bundle is missing | `@deepseek-ai/dsh-base` must be in `dsh.profile.bundles` in the profile's `package.json` |
| `patch: entry not found` | the plugin is not installed in that profile | run `dsh plugin --profile <name> add <pkg>` first, or just run the installer |
| `must be a top-level YAML array` | `cordis.patch.yml` got corrupted | restore the array form (top level starts with `- id:`) |

Diagnose with:

```bash
dsh --profile qq --dump-config
```

### 2. It says `no CodeBuddy login found`

There is no **plaintext** `.info` file in the login directory. Check:

```bash
ls "$LOCALAPPDATA/CodeBuddyExtension/Data/Public/auth/"
```

- the file is there but not recognized -> it is the encrypted variant
  (`workbuddy-desktop.info`), which the plugin skips
- the file is missing -> the path is wrong; point `CB_AUTH_DIR` at it explicitly

### 3. It reports `11128 / Request blocked`

The request failed the official channel check. Check three things:

1. Is the first message `role: system`? (the plugin adds it automatically, but be careful
   if you changed `personaPrefix` under `system-prompt` in `cordis.patch.yml`)
2. Was the UA customized to a non-official format? (leave `userAgent` alone unless you
   know better)
3. Are `x-product: SaaS`, `x-domain` and `x-user-id` all present?

### 4. It reports `401`

The token expired, or the domain does not accept this account. The plugin tries to refresh
it and falls back to the other domain if that fails.

Inspect it manually:

```bash
node -e "
import('./src/credentials.js').then(async m => {
  const c = await m.openCredentialManager();
  console.log(await c.summary());
});
"
```

### 5. The QR code does not scan

The terminal does not support the `▀▄` half-block characters (common on older Windows
consoles). Fix:

```bash
node scripts/login.mjs --no-qr     # print the link only
```

Or switch to a UTF-8 capable terminal (Windows Terminal, the VS Code terminal, macOS/iTerm).

### 6. The QR login never completes

While waiting for the confirmation the server returns `code 11217` (`login ing...`).
If it never changes:

- the code expired -> run it again
- you scanned but did not tap Confirm on the authorization page -> after scanning with
  WeChat / QQ you still have to tap Confirm on the phone
- wrong domain -> try `--domain www.codebuddy.ai`

### 7. The service disappears after a restart

The SSH disconnect reaped the child process. Use a scheduled task
(see [4.2](#42-keep-it-alive-with-a-scheduled-task)).

### 8. The account got risk-controlled (`11140`)

The server answered "the account exhibited abnormal behaviour and has been restricted".
What to do:

1. The plugin cools the account down and switches; check `listAccounts` for a usable one
2. You can appeal the restricted account (the error code carries a `SUBMIT_FEEDBACK` action)
3. Lower the request rate: raise `minIntervalMs` to 2000 or more
4. Use `--domain` to move to an account on the other domain

---

## 7. Command reference

### Installer

```powershell
.\scripts\install.ps1 -Profile <name>                    # install
.\scripts\install.ps1 -Profile <name> -Accounts <dir>     # install + import .info
.\scripts\install.ps1 -Profile <name> -Enable            # install + set the default model
.\scripts\install.ps1 -Profile <name> -Login             # install + start the QR login
.\scripts\install.ps1 -Profile <name> -Login -LoginDomain www.codebuddy.ai
.\scripts\install.ps1 -Profile <name> -Force             # overwrite the existing provider config
.\scripts\install.ps1 -Profile <name> -Uninstall         # uninstall
```

### QR-code login

```bash
node scripts/login.mjs                        # default domain
node scripts/login.mjs --domain www.codebuddy.ai
node scripts/login.mjs --no-qr                # print the link only
node scripts/login.mjs --open                 # also open a browser
```

### dsh

```bash
dsh --profile <name> headless "task"          # run once
dsh --profile <name> --dump-config            # print the config tree
dsh --profile <name> --dump-config-schema     # print the patch schema
dsh plugin --profile <name> add <pkg>          # add a plugin
dsh plugin --profile <name> remove <pkg>       # remove a plugin
```

### Plugin API

```javascript
import {
  login, startLogin, waitForToken, fetchAccount, writeAccountFile,
  listAccounts, findAuthFiles, openCredentialManager,
  CodeBuddyProvider, encodeQr, qrToTerminal,
} from 'dsh-codebuddy-provider';
```

---

## 8. Uninstall and rollback

### Uninstall the plugin

```powershell
.\scripts\install.ps1 -Profile qq -Uninstall
```

This removes `node_modules/dsh-codebuddy-provider` and drops the dependency and the
bundle entry from `package.json`.

> The provider block injected into `cordis.patch.yml` is **left in place** (so a user's own
> config is never wiped by accident). To remove it fully, delete the `providers:` section
> under that `- id: llm-pi-ai` entry by hand.

### Your accounts are kept

Uninstalling the plugin does **not** delete the `.info` files. The credentials live
independently of the plugin, so reinstalling picks them right back up.

### Roll back to a specific commit

```bash
git log --oneline
git checkout <commit-sha>
```

---

## Appendix: environment variables

| Variable | Purpose | Default |
|---|---|---|
| `CB_AUTH_DIR` | login directory (separate multiple with `;`) | derived per platform |
| `CB_CLI_VERSION` | override the CLI version in the UA | auto-detected locally |
| `DSH_HOME` | dsh home | `~/.dsh` |

---

Start with [Troubleshooting](#6-troubleshooting) - it covers the eight most common situations.
