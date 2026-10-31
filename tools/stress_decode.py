"""随机压力测试：生成大量随机 QR，用 zxing-cpp 解码验证。"""
import os, random, subprocess, sys, json
import zxingcpp
from PIL import Image

JS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
random.seed(20261031)

def render(matrix, scale=6, quiet=4):
    size = len(matrix)
    dim = (size + quiet * 2) * scale
    img = Image.new("L", (dim, dim), 255)
    px = img.load()
    for y, row in enumerate(matrix):
        for x, v in enumerate(row):
            if not v: continue
            x0 = (x + quiet) * scale; y0 = (y + quiet) * scale
            for dy in range(scale):
                for dx in range(scale):
                    px[x0+dx, y0+dy] = 0
    return img

def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    ok = fail = skip = 0
    fails = []
    for i in range(n):
        # 随机长度，落在版本 1-10 覆盖范围
        length = random.choice([random.randint(1, 60), random.randint(60, 130), random.randint(130, 210)])
        alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/.-_?=&"
        text = "".join(random.choice(alphabet) for _ in range(length))
        ec = random.choice(["L", "M"])
        raw = subprocess.run(
            ["node", f"{JS_DIR}/tools/qrdec.mjs", text, ec],
            capture_output=True, text=True, encoding="utf-8")
        if raw.returncode != 0:
            print("node error:", raw.stderr[:200]); return 1
        item = json.loads(raw.stdout)[0]
        if "error" in item:
            skip += 1; continue
        res = zxingcpp.read_barcodes(render(item["matrix"]))
        decoded = res[0].text if res else None
        if decoded == text:
            ok += 1
        else:
            fail += 1
            fails.append((length, ec, item["version"], text[:40], str(decoded)[:40]))
    print(f"STRESS RESULT: ok={ok} fail={fail} skip={skip}")
    for f in fails[:6]:
        print("  FAIL", f)
    return 0 if fail == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
