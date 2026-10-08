from __future__ import annotations

import re
from typing import NamedTuple


class Heading(NamedTuple):
    level: int
    title: str


def extract_headings(text: str) -> list[Heading]:
    headings = []
    for line in text.splitlines():
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match:
            headings.append(Heading(len(match.group(1)), match.group(2)))
    return headings
