// 修改 profile 的 package.json：登记依赖与 bundle。
// 用 Node 而不是 PowerShell 的 ConvertFrom-Json/ConvertTo-Json：
// 后者对空对象、无 BOM 写入等边界情况很脆弱，而 dsh 用 JSON.parse 严格读取该文件。
//
// 用法：node edit-package-json.js <packageJsonPath> <bundleName> <dependencyName> <dependencySpec>

import { readFileSync, writeFileSync } from 'node:fs';

const [, , pkgPath, bundleName, depName, depSpec] = process.argv;

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf-8').replace(/^\uFEFF/, ''));
} catch {
  pkg = {};
}

if (!pkg.name) pkg.name = 'dsh-profile';
if (!pkg.private) pkg.private = true;
if (!pkg.dependencies || typeof pkg.dependencies !== 'object') pkg.dependencies = {};
pkg.dependencies[depName] = depSpec;

if (!pkg.dsh || typeof pkg.dsh !== 'object') pkg.dsh = {};
if (!pkg.dsh.profile || typeof pkg.dsh.profile !== 'object') pkg.dsh.profile = {};
if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
if (!pkg.dsh.profile.bundles.includes(bundleName)) {
  pkg.dsh.profile.bundles.push(bundleName);
}

// 无 BOM：dsh 用 Node 的 JSON.parse 读取，BOM 会被当成非法字符
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
console.log(`updated ${pkgPath}`);
console.log(`  dependencies.${depName} = ${depSpec}`);
console.log(`  dsh.profile.bundles = ${pkg.dsh.profile.bundles.join(', ')}`);
