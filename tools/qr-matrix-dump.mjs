// 导出 QR 矩阵（JSON），供 tools/verify_qr.py 与参考实现交叉比对。
import { encodeQr } from '../src/qr.js';

const cases = [
  'https://www.workbuddy.ai/login?platform=workbuddy&state=c109d321-6687-43a4-b70b-bb67a6633051',
  'https://copilot.tencent.com/login?platform=CLI&state=2db16588&version=2.179.0',
  'https://www.codebuddy.ai/login?platform=codebuddy&state=6f2d1c75',
  'A',
  'hello world',
  'x'.repeat(100),
  'https://example.com/path?query=1&other=2#frag',
  'https://www.workbuddy.ai/login?platform=workbuddy&state=' + '0123456789abcdef'.repeat(6),
];

const out = cases.map((text) => ({
  text,
  rows: ['L', 'M'].map((ec) => {
    const qr = encodeQr(text, { ecLevel: ec });
    return qr.modules.map((row) => row.map((v) => (v ? '1' : '0')).join(''));
  }),
}));

process.stdout.write(JSON.stringify(out));
