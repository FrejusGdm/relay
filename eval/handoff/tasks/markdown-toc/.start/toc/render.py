from __future__ import annotations


def render_toc(headings) -> str:
    lines = []
    for level, title in headings:
        anchor = title.lower().replace(" ", "-")
        lines.append("  " * (level - 1) + f"- [{title}](#{anchor})")
    return "\n".join(lines)
