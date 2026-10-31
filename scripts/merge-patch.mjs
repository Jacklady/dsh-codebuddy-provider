// 合并 provider 配置到 profile 的 cordis.patch.yml。
//
// 全部用 Node 处理文本：
//   - Windows PowerShell 的 Get-Content/Set-Content 会破坏换行与编码；
//   - dsh 用 YAML 解析该文件，换行被压成一行会让整个数组失效；
//   - dsh 用 JSON.parse 读 package.json，BOM 会让解析失败。
// 因此这里统一用 Node：读 UTF-8、保留 \n、写 UTF-8 无 BOM。
//
// 用法：node merge-patch.mjs <profileDir> <templateFile> [--force]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , profileDir, templateFile, ...flags] = process.argv;
const force = flags.includes('--force');

const patchPath = join(profileDir, 'cordis.patch.yml');
const template = readFileSync(templateFile, 'utf-8').replace(/^\uFEFF/, '');

// 顶层必须是 YAML 数组：以 "- id:" 开头（注释行也允许出现在数组元素内部）。
// 允许空数组 —— 模板可能只提供注释示例，或写成 "[]"。
function normalize(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const body = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (body.length === 0) return '[]\n';
  const first = body[0].trim();
  if (first === '[]') return '[]\n';
  if (!first.startsWith('- ')) {
    throw new Error('template must be a top-level YAML array (start with "- id:" or "[]")');
  }
  return body.join('\n') + '\n';
}

const block = normalize(template);
let existing = existsSync(patchPath)
  ? readFileSync(patchPath, 'utf-8').replace(/^\uFEFF/, '')
  : '';

if (!existing.trim()) {
  writeFileSync(patchPath, block, 'utf-8');
  console.log(`created ${patchPath}`);
  process.exit(0);
}

if (force) {
  writeFileSync(patchPath, block, 'utf-8');
  console.log(`overwrote ${patchPath}`);
  process.exit(0);
}

// 已声明同名 provider 就保持原样，避免覆盖用户自己的模型列表。
// 注意只匹配 llm-pi-ai 的 providers 字典下的条目（缩进 6 空格的 "name:" 形式），
// 插件自己的 codebuddy-official 路由不在这里。
if (/^\s{6}codebuddy:\s*$/m.test(existing)) {
  console.log('cordis.patch.yml already declares a codebuddy provider; left untouched');
  process.exit(0);
}

const merged = existing.replace(/\r\n/g, '\n').replace(/\s*$/, '\n') + '\n' + block;
writeFileSync(patchPath, merged, 'utf-8');
console.log(`appended CodeBuddy provider block to ${patchPath}`);
