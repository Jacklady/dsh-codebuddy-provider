<#
.SYNOPSIS
  一键安装 dsh-codebuddy-provider 到指定的 dsh profile。

.DESCRIPTION
  完成以下动作：
    1. 复制插件到 profile 的 node_modules（不污染 pnpm store，便于卸载）；
    2. 在 profile 的 package.json 中登记依赖与 bundle；
    3. 合并（而非覆盖）cordis.patch.yml 中的 CodeBuddy provider 配置；
    4. 可选：把账号 .info 文件复制到官方登录目录；
    5. 可选：把默认模型切到 CodeBuddy；
    6. 校验配置能否被 dsh 解析。

  YAML 片段全部来自 templates/ 下的独立文件，不在脚本内拼接 YAML，
  以避免不同 PowerShell 版本对 here-string 解析的差异。

.EXAMPLE
  .\install.ps1 -Profile qq
  .\install.ps1 -Profile qq -Accounts C:\accounts -Enable
  .\install.ps1 -Profile qq -Uninstall
#>
[CmdletBinding()]
param(
  # dsh profile 名称（$DSH_HOME/profiles 下的目录名）
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Profile,

  # 插件源码目录，默认为脚本所在目录
  [string]$SourceDir = $PSScriptRoot,

  # 账号 .info 文件所在目录（可选）
  [string]$Accounts,

  # 安装完成后是否把默认模型切到 CodeBuddy
  [switch]$Enable,

  # 卸载
  [switch]$Uninstall,

  # 覆盖已存在的同名 provider 配置
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 任何未捕获错误都要可见，否则远程执行时只会看到「静默退出」
trap {
  Write-Host ""
  Write-Host "INSTALL FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  exit 1
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Note($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# JSON/YAML 必须写成 UTF-8 **无 BOM**：dsh 用 Node 的 JSON.parse 读取 package.json，
# BOM 会被当成非法字符。Windows 的 Set-Content -Encoding UTF8 会带 BOM，
# 因此这里统一用 .NET 的 UTF8Encoding(false)。
function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Path,
    [Parameter(Mandatory = $true, Position = 1)][string]$Value
  )
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Get-DshHome {
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return Join-Path $env:USERPROFILE '.dsh'
}

function Get-AuthDir {
  if ($env:CB_AUTH_DIR) { return ($env:CB_AUTH_DIR -split ';')[0] }
  if ($env:OS -eq 'Windows_NT') {
    return (Join-Path $env:LOCALAPPDATA 'CodeBuddyExtension\Data\Public\auth')
  }
  if ($IsMacOS) {
    return (Join-Path $HOME 'Library/Application Support/CodeBuddyExtension/Data/Public/auth')
  }
  return (Join-Path $HOME '.local/share/CodeBuddyExtension/Data/Public/auth')
}

$dshHome = Get-DshHome

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "node is required (dsh itself runs on node)" }
$node = $nodeCmd.Source
$profileDir = Join-Path $dshHome "profiles\$Profile"

if (-not (Test-Path $profileDir)) {
  throw "profile not found: $profileDir"
}

$pkgPath      = Join-Path $profileDir 'package.json'
$patchPath    = Join-Path $profileDir 'cordis.patch.yml'
$modulesDir   = Join-Path $profileDir 'node_modules'
$pluginDir    = Join-Path $modulesDir 'dsh-codebuddy-provider'
$templateDir  = Join-Path $SourceDir 'templates'

# ------------------------------------------------------------------ 卸载
if ($Uninstall) {
  Write-Step "Uninstalling dsh-codebuddy-provider from profile '$Profile'"
  if (Test-Path $pluginDir) {
    Remove-Item $pluginDir -Recurse -Force
    Write-Ok "removed $pluginDir"
  } else {
    Write-Note "plugin directory not present"
  }

  if (Test-Path $pkgPath) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
      $editor = Join-Path $SourceDir 'scripts\remove-bundle.mjs'
      if (Test-Path $editor) {
        & $nodeCmd.Source $editor $pkgPath 'dsh-codebuddy-provider' 'dsh-codebuddy-provider' 2>&1 |
          ForEach-Object { Write-Host "    $_" }
      }
    }
    Write-Ok "package.json updated"
  }
  Write-Ok "done. The provider block in cordis.patch.yml was left in place; remove it manually if unwanted."
  exit 0
}

# ------------------------------------------------------------------ 安装
Write-Step "Installing dsh-codebuddy-provider into profile '$Profile'"

if (-not (Test-Path (Join-Path $SourceDir 'src\index.js'))) {
  throw "invalid plugin source: $SourceDir (src\index.js not found)"
}

# 0) profile 必须具备 pnpm-workspace.yaml / cordis.yml / package.json 才会被 dsh 识别

$workspaceFile = Join-Path $profileDir 'pnpm-workspace.yaml'
if (-not (Test-Path $workspaceFile)) {
  Write-Utf8NoBom -Path $workspaceFile -Value "packages:`n  - .`n`nnodeLinker: hoisted`nautoInstallPeers: false`n"
  Write-Ok "created pnpm-workspace.yaml"
}
$cordisFile = Join-Path $profileDir 'cordis.yml'
if (-not (Test-Path $cordisFile)) {
  Write-Utf8NoBom -Path $cordisFile -Value "[]`n"
  Write-Ok "created cordis.yml"
}
if (-not (Test-Path $pkgPath)) {
  & $node (Join-Path $SourceDir 'scripts\create-package-json.mjs') $pkgPath $Profile 2>&1 |
    ForEach-Object { Write-Host "    $_" }
  Write-Ok "created package.json"
}

# 1) 复制插件源码
New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
if (Test-Path $pluginDir) { Remove-Item $pluginDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item (Join-Path $SourceDir 'src') -Destination $pluginDir -Recurse -Force
Copy-Item (Join-Path $SourceDir 'package.json') -Destination (Join-Path $pluginDir 'package.json') -Force
$bundlePatch = Join-Path $SourceDir 'cordis.patch.yml'
if (Test-Path $bundlePatch) {
  Copy-Item $bundlePatch -Destination (Join-Path $pluginDir 'cordis.patch.yml') -Force
}
if (Test-Path $templateDir) {
  Copy-Item $templateDir -Destination $pluginDir -Recurse -Force
}
Write-Ok "plugin copied to $pluginDir"

# 2) package.json —— 用 Node 编辑，避免 PowerShell 的 JSON 序列化破坏文件
if (-not (Test-Path $pkgPath)) { throw "missing $pkgPath" }
$editor = Join-Path $SourceDir 'scripts\edit-package-json.mjs'
if (-not (Test-Path $editor)) { throw "missing editor script: $editor" }

& $node $editor $pkgPath 'dsh-codebuddy-provider' 'dsh-codebuddy-provider' 'file:./node_modules/dsh-codebuddy-provider' 2>&1 |
  ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { throw "failed to update package.json (node exit $LASTEXITCODE)" }
Write-Ok "package.json updated"

# 3) cordis.patch.yml —— 用 Node 合并 provider 片段
#    （PowerShell 的 Get-Content/Set-Content 会压掉换行，导致 YAML 数组失效）
$providerTemplate = Join-Path $templateDir 'codebuddy-provider.yml'
if (-not (Test-Path $providerTemplate)) {
  throw "missing template: $providerTemplate"
}
$mergeScript = Join-Path $SourceDir 'scripts\merge-patch.mjs'
if (-not (Test-Path $mergeScript)) { throw "missing script: $mergeScript" }

$mergeArgs = @($mergeScript, $profileDir, $providerTemplate)
if ($Force) { $mergeArgs += '--force' }
& $node $mergeArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { throw "failed to update cordis.patch.yml (node exit $LASTEXITCODE)" }

# 4) 账号文件
if ($Accounts) {
  if (-not (Test-Path $Accounts)) { throw "accounts directory not found: $Accounts" }
  $authDir = Get-AuthDir
  New-Item -ItemType Directory -Force -Path $authDir | Out-Null
  $copied = 0
  Get-ChildItem $Accounts -Filter '*.info' -File | ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $authDir $_.Name) -Force
    $copied++
  }
  Write-Ok "copied $copied account file(s) to $authDir"
}

# 5) 默认模型
if ($Enable) {
  $modelTemplate = Join-Path $templateDir 'default-model.yml'
  $appendScript = Join-Path $SourceDir 'scripts\append-patch.mjs'
  if (Test-Path $modelTemplate -and (Test-Path $appendScript)) {
    & $node $appendScript $profileDir $modelTemplate 'agent-default-model' 2>&1 |
      ForEach-Object { Write-Host "    $_" }
  }
}

# 6) 校验
Write-Step "Validating profile configuration"
$dshEntry = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $dshEntry)) {
  $dshEntry = Join-Path $env:LOCALAPPDATA 'node\node_modules\@deepseek-ai\dsh\lib\bin.js'
}
if (-not (Test-Path $dshEntry)) {
  $dshEntry = Join-Path $HOME '.local\node\node_modules\@deepseek-ai\dsh\lib\bin.js'
}

if (Test-Path $dshEntry) {
  $dump = & $node $dshEntry --profile $Profile --dump-config 2>&1
  $errors = $dump | Select-String -Pattern 'not found|skipping|Error:|invalid'
  if ($errors) {
    Write-Note "configuration reported problems:"
    $errors | Select-Object -First 8 | ForEach-Object { Write-Host ("        " + $_.Line) -ForegroundColor Red }
  } else {
    Write-Ok "configuration parses cleanly"
  }
} else {
  Write-Note "dsh entry point not found; skipped validation (start dsh once, then re-run install)"
}

Write-Step "Done"
Write-Host ("    next: dsh --profile " + $Profile + " headless `"hello`"") -ForegroundColor Gray
Write-Host ("    docs: " + (Join-Path $SourceDir 'README.zh.md')) -ForegroundColor Gray
