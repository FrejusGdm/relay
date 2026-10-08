from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .headings import extract_headings
from .render import render_toc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file")
    parser.add_argument("--max-depth", type=int)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    path = Path(args.file)
    with path.open(encoding="utf-8", newline="") as source:
        text = source.read()
    rendered = render_toc(extract_headings(text), args.max_depth)
    if not args.write:
        print(rendered)
        return 0
    lines = text.splitlines(keepends=True)
    markers = []
    for marker in ("<!-- toc -->", "<!-- tocstop -->"):
        index = next((i for i, line in enumerate(lines)
                      if line.rstrip("\r\n").rstrip(" ") == marker), None)
        if index is None:
            print(f"No {marker} marker in {args.file}", file=sys.stderr)
            return 1
        markers.append(index)
    start, stop = markers
    newline = "\r\n" if lines[start].endswith("\r\n") else "\n"
    replacement = rendered.replace("\n", newline) + newline if rendered else ""
    updated = "".join(lines[:start + 1]) + replacement + "".join(lines[stop:])
    with path.open("w", encoding="utf-8", newline="") as output:
        output.write(updated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
