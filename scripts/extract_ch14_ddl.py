#!/usr/bin/env python3
"""Print executable PostgreSQL fences from Chapter 14 in document order."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "chapters" / "14-data-model.md"


def main() -> None:
    text = SOURCE.read_text(encoding="utf-8")
    blocks = re.findall(r"(?:^|\n)(?:```|~~~)sql\s*\n([\s\S]*?)\n(?:```|~~~)(?=\n|$)", text)
    for block in blocks:
        print(block)


if __name__ == "__main__":
    main()
