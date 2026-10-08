from __future__ import annotations

import re
from typing import NamedTuple


class Heading(NamedTuple):
    level: int
    title: str


def extract_headings(text: str) -> list[Heading]:
    headings = []
    fence_character = ""
    fence_length = 0
    previous = None
    for line in text.splitlines():
        if fence_character:
            if re.fullmatch(" {0,3}" + re.escape(fence_character) + "{" + str(fence_length) + r",} *", line):
                fence_character = ""
                fence_length = 0
            previous = None
            continue
        fence = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if fence:
            fence_character = fence.group(1)[0]
            fence_length = len(fence.group(1))
            previous = None
            continue
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match:
            title = re.sub(r"(?: +|^)#+$", "", match.group(2)).rstrip(" ")
            headings.append(Heading(len(match.group(1)), title))
            previous = None
            continue
        underline = re.fullmatch(r"(=+|-+) *", line)
        if underline and previous is not None:
            headings.append(Heading(1 if underline.group(1)[0] == "=" else 2, previous))
            previous = None
        else:
            previous = line if line.strip() else None
    return headings
