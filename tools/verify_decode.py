"""用真实解码器（zxing-cpp）验证 JS 端生成的 QR 矩阵。

流程：
  1. Node 导出 QR 矩阵（PNG 无关的原始位图）
  2. Python 把位图渲染成图片
  3. zxing-cpp 解码，比对还原出的文本

这比「与参考实现逐位比对」更有意义 —— 它验证的是
「扫�� App 能否真正识别出这条链接」。
"""

import json
import subprocess
import sys

import zxingcpp
from PIL import Image

import os
JS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def render(matrix, scale=8, quiet=4):
    """把模块矩阵渲染成黑白图片（纯 PIL，不依赖 numpy）。"""
    size = len(matrix)
    dim = (size + quiet * 2) * scale
    img = Image.new("L", (dim, dim), 255)
    pixels = img.load()
    for y, row in enumerate(matrix):
        for x, v in enumerate(row):
            if not v:
                continue
            x0 = (x + quiet) * scale
            y0 = (y + quiet) * scale
            for dy in range(scale):
                for dx in range(scale):
                    pixels[x0 + dx, y0 + dy] = 0
    return img


def run_node(script, *args):
    cmd = ["node", f"{JS_DIR}/tools/{script}", *args]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise RuntimeError(f"node failed: {out.stderr[:500]}")
    return out.stdout


def main():
    import random
    random.seed(42)
    cases = [
        "https://www.workbuddy.ai/login?platform=workbuddy&state=c109d321-6687-43a4-b70b-bb67a6633051",
        "https://copilot.tencent.com/login?platform=CLI&state=2db16588-0255-404f-b2af-e4075213c649&version=2.179.0",
        "https://www.codebuddy.ai/login?platform=codebuddy&state=6f2d1c75-b546-4641-8e3f-46f15f05138b",
        "A",
        "hello world",
        "https://example.com/path?query=1&other=2#frag",
        "x" * 100,
        "中文测试：扫码登录 WorkBuddy 账号 ✅",
        "y" * 250,
        "z" * 400,
        "https://example.com/" + "p" * 150,
        "特殊字符 " + "!@#$%^&*()_+-=[]{}|;':\",./<>? " * 3,
        "".join(chr(random.randint(32, 126)) for _ in range(180)),
        "https://www.workbuddy.ai/login?platform=workbuddy&state=" + "0123456789abcdef" * 6,
        "emoji 🚀 test 中文 mixed 123",
        "0" * 271,
        "1" * 19,
        "2" * 20,
        "3" * 55,
        "4" * 56,
    ]

    # 逐个生成并解码
    script = """
import { encodeQr } from '../src/qr.js';
const text = process.argv[2];
const ec = process.argv[3] ?? 'M';
const out = [];
try {
  const qr = encodeQr(text, { ecLevel: ec });
  out.push({ ec, version: qr.version, size: qr.size, mask: qr.mask,
             matrix: qr.modules.map(r => r.map(v => v ? 1 : 0)) });
} catch (e) {
  out.push({ ec, error: e.message });
}
process.stdout.write(JSON.stringify(out));
"""
    with open(f"{JS_DIR}/tools/qrdec.mjs", "w", encoding="utf-8") as fh:
        fh.write(script)

    total = ok = 0
    failures = []
    for text in cases:
        raw = run_node("qrdec.mjs", text, "M")
        for item in json.loads(raw):
            if "error" in item:
                print(f"  SKIP  len={len(text):3d} ec={item['ec']}  {item['error'][:70]}")
                continue
            total += 1
            img = render(item["matrix"])
            results = zxingcpp.read_barcodes(img)
            decoded = results[0].text if results else None
            if decoded == text:
                ok += 1
            else:
                failures.append((text, decoded, item))
                print(f"  FAIL  len={len(text):3d} ec={item['ec']} v={item['version']} mask={item['mask']}")
                print(f"        expected: {text[:70]}")
                print(f"        decoded : {str(decoded)[:70]}")

    print(f"\nDECODE RESULT: {ok}/{total} SUCCESS")
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
