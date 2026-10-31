// 向 profile 的 cordis.patch.yml 追加一段 patch（默认模型切换等）。
//
// 用法：node append-patch.mjs <profileDir> <templateFile> <markerId>
// markerId 是该 patch 的 id；若已存在则跳过。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , profileDir, templateFile, markerId] = process.argv;

const patchPath = join(profileDir, 'cordis.patch.yml');
const template = readFileSync(templateFile, 'utf-8').replace(/^\uFEFF/, '');

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

if (existing.includes(`- id: ${markerId}`)) {
  console.log(`${markerId} already configured; left untouched`);
  process.exit(0);
}

const merged = (existing.replace(/\r\n/g, '\n').replace(/\s*$/, '\n') + '\n' + block);
writeFileSync(patchPath, merged, 'utf-8');
console.log(`appended ${markerId} to ${patchPath}`);
