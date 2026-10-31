#!/usr/bin/env node
/**
 * 扫码登录 CodeBuddy / WorkBuddy 官方账号。
 *
 * 用法：
 *   node scripts/login.mjs                       # 扫码并写入官方登录目录
 *   node scripts/login.mjs --domain www.codebuddy.cn
 *   node scripts/login.mjs --no-qr               # 只打印链接，不渲染二维码
 *   node scripts/login.mjs --open                # 顺便用默认浏览器打开授权页
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

import { startLogin, waitForToken, fetchAccount, writeAccountFile } from '../src/login.js';
import { qrToTerminal } from '../src/qr.js';
import { listAccounts } from '../src/credentials.js';

function parseArgs(argv) {
  const options = { qr: true, open: false, domain: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-qr') options.qr = false;
    else if (arg === '--open') options.open = true;
    else if (arg === '--domain') options.domain = argv[++i];
    else if (arg.startsWith('--domain=')) options.domain = arg.slice('--domain='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function openInBrowser(url) {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    /* 打不开浏览器不影响扫码流程 */
  }
}

function printHelp() {
  console.log(`
扫码登录 CodeBuddy / WorkBuddy 官方账号

用法:
  node scripts/login.mjs [选项]

选项:
  --domain <域>       登录域，默认 ${'www.workbuddy.ai'}
                      可选: www.workbuddy.ai / www.codebuddy.ai / www.codebuddy.cn
  --no-qr             不在终端渲染二维码，只打印链接
  --open              用默认浏览器打开授权页
  -h, --help          显示帮助

登录成功后，凭证会写入官方登录目录，插件会自动发现并使用它。
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  console.log('正在发起登录请求…');
  const started = await startLogin({ domain: options.domain });

  console.log('\n请用手机或浏览器完成授权：');
  console.log(`  ${started.authUrl}\n`);

  if (options.qr) {
    console.log('或直接扫描下方二维码：');
    console.log(qrToTerminal(started.authUrl, { ecLevel: 'M' }));
    console.log('');
  }

  if (options.open) openInBrowser(started.authUrl);

  let lastLine = '';
  const session = await waitForToken({
    ...started,
    onPoll: ({ elapsedMs, msg }) => {
      const seconds = Math.floor(elapsedMs / 1000);
      const line = `  等待扫码确认… ${seconds}s${msg ? ` (${msg})` : ''}`;
      if (line !== lastLine) {
        process.stdout.write(`\r${line.padEnd(60)}`);
        lastLine = line;
      }
    },
  });
  process.stdout.write('\r' + ' '.repeat(62) + '\r');

  const account = await fetchAccount({ ...session, host: started.host });
  const file = await writeAccountFile({ session, account });

  console.log('登录成功。');
  console.log(`  账号: ${account.nickname || '(未命名)'}  (${account.uin || account.uid})`);
  console.log(`  域:   ${session.domain}`);
  console.log(`  文件: ${file}\n`);

  const accounts = await listAccounts();
  console.log(`当前可用账号（${accounts.length} 个）：`);
  for (const item of accounts) {
    console.log(`  - ${item.nickname || '(未命名)'}  [${item.domain}]  ${item.name}`);
  }
}

main().catch((err) => {
  console.error(`\n登录失败: ${err.message}`);
  process.exitCode = 1;
});
