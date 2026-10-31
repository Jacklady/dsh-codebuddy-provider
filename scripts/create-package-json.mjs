// 创建一个空的 dsh profile package.json（无 BOM）。
// 用法：node create-package-json.mjs <packageJsonPath> <profileName>

import { writeFileSync } from 'node:fs';

const [, , pkgPath, profileName] = process.argv;

const pkg = {
  name: `dsh-profile-${profileName}`,
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: [],
    },
  },
};

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
console.log(`created ${pkgPath}`);
