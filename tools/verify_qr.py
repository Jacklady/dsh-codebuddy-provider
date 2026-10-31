#!/usr/bin/env python3
"""交叉验证 JS 端 QR 编码器的输出是否与参考实现逐位一致。

用法：
    node tools/qr-matrix-dump.mjs > /tmp/qr-js.json
    python3 tools/verify_qr.py /tmp/qr-js.json

参考实现（Python 的 qrcode 库）会自动挑选最优编码模式，
这里强制使用字节模式，才能与本项目的实现对齐比较。
"""

import json
import sys

import qrcode
from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_M
from qrcode.util import MODE_8BIT_BYTE, QRData


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: verify_qr.py <qr-js.json>")
        return 2

    with open(sys.argv[1], encoding="utf-8") as fh:
        cases = json.load(fh)

    levels = [ERROR_CORRECT_L, ERROR_CORRECT_M]
    checked = 0

    for case in cases:
        for index, ec in enumerate(levels):
            qr = qrcode.QRCode(error_correction=ec, box_size=1, border=0)
            qr.add_data(QRData(case["text"], mode=MODE_8BIT_BYTE))
            qr.make(fit=True)
            expected = ["".join("1" if v else "0" for v in row) for row in qr.get_matrix()]
            actual = case["rows"][index]

            if expected != actual:
                print("QR mismatch for %r (EC index %d)" % (case["text"][:60], index))
                for i, (a, b) in enumerate(zip(expected, actual)):
                    if a != b:
                        print("  row %d" % i)
                        print("    expected %s" % a)
                        print("    actual   %s" % b)
                        break
                return 1
            checked += 1

    print("QR encoder matches the reference implementation on %d cases" % checked)
    return 0


if __name__ == "__main__":
    sys.exit(main())
