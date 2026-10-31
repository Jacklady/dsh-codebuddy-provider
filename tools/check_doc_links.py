#!/usr/bin/env python3
"""检查文档里的相对链接与锚点是否都能对上。

用法：python3 tools/check_doc_links.py
退出码非 0 表示有断链。
"""

import pathlib
import re
import sys

DOCS = ["README.md", "README.zh.md", "docs/guide.md", "docs/guide.zh.md"]


def anchors_of(text: str) -> set:
    """收集文档里所有标题生成的锚点。"""
    anchors = set()
    for match in re.finditer(r"^#+\s+(.+)$", text, re.M):
        slug = match.group(1).strip().lower()
        slug = re.sub(r"[^\w\s\u4e00-\u9fff-]", "", slug).replace(" ", "-")
        anchors.add(slug)
    return anchors


def main() -> int:
    root = pathlib.Path(__file__).resolve().parent.parent
    broken = []

    for name in DOCS:
        path = root / name
        if not path.exists():
            broken.append(f"{name}: file is missing")
            continue

        text = path.read_text(encoding="utf-8")

        # 相对文件链接
        for match in re.finditer(r"\]\((\./[^)#]+)", text):
            target = (path.parent / match.group(1)).resolve()
            if not target.exists():
                broken.append(f"{name}: {match.group(1)}")

        # 文档内锚点
        anchors = anchors_of(text)
        for match in re.finditer(r"\]\(#([^)]+)\)", text):
            if match.group(1) not in anchors:
                broken.append(f"{name}: #{match.group(1)}")

    if broken:
        print("broken documentation links:")
        for item in broken:
            print("  " + item)
        return 1

    print(f"all documentation links resolve ({len(DOCS)} documents)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
