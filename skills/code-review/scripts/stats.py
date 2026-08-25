#!/usr/bin/env python3
"""Quick source-code stats for the code-review skill.

Usage:
    python3 stats.py <file>

Prints total lines, non-comment/blank lines, function/method count and
TODO/FIXME count — handy for judging a file's size before reviewing it.
"""

import re
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python3 stats.py <file>")
        sys.exit(1)
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"error: {path} not found")
        sys.exit(1)

    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    code = [
        line
        for line in lines
        if line.strip() and not line.lstrip().startswith(("#", "//", "/*", "*"))
    ]
    funcs = len(
        re.findall(
            r"\b(?:def\s+\w+|function\s+\w+|const\s+\w+\s*=\s*\(|async\s+function)\b",
            text,
        )
    )
    print(f"file: {path}")
    print(f"total lines: {len(lines)}")
    print(f"non-comment/blank lines: {len(code)}")
    print(f"functions/methods: {funcs}")
    print(f"TODO/FIXME: {len(re.findall(r'TODO|FIXME', text))}")


if __name__ == "__main__":
    main()
