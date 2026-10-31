// 从 profile 的 package.json 中移除某个 bundle 与其依赖。
// 与 edit-package-json.mjs 配对使用。
//
// 用法：node remove-bundle.mjs <packageJsonPath> <bundleName> <dependencyName>

import { readFileSync, writeFileSync } from 'node:fs';

const [, , pkgPath, bundleName, depName] = process.argv;

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf-8').replace(/^\uFEFF/, ''));
} catch {
  console.log(`skip: ${pkgPath} is not readable JSON`);
  process.exit(0);
}

if (pkg.dependencies && typeof pkg.dependencies === 'object') {
  delete pkg.dependencies[depName];
}
const bundles = pkg.dsh?.profile?.bundles;
if (Array.isArray(bundles)) {
  pkg.dsh.profile.bundles = bundles.filter((b) => b !== bundleName);
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
console.log(`updated ${pkgPath}`);
console.log(`  dsh.profile.bundles = ${(pkg.dsh?.profile?.bundles ?? []).join(', ')}`);
