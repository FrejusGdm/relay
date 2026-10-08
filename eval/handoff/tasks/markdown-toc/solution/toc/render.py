from __future__ import annotations


def render_toc(headings, max_depth: int | None = None) -> str:
    """Anchors are numbered over every heading, as GitHub numbers them on the page, before
    headings deeper than max_depth are left out."""
    entries = []
    used = {}
    for level, title in headings:
        base = "".join(ch for ch in title.lower() if ch.isalnum() or ch in " -_")
        base = base.replace(" ", "-")
        anchor = base
        while anchor in used:
            used[base] += 1
            anchor = f"{base}-{used[base]}"
        used[anchor] = 0
        if max_depth is None or level <= max_depth:
            entries.append((level, title, anchor))
    if not entries:
        return ""
    smallest = min(level for level, _, _ in entries)
    return "\n".join("  " * (level - smallest) + f"- [{title}](#{anchor})"
                     for level, title, anchor in entries)
