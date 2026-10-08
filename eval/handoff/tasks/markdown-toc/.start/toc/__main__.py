from __future__ import annotations

import argparse
from pathlib import Path

from .headings import extract_headings
from .render import render_toc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("file")
    args = parser.parse_args()
    text = Path(args.file).read_text(encoding="utf-8")
    print(render_toc(extract_headings(text)))


if __name__ == "__main__":
    main()
