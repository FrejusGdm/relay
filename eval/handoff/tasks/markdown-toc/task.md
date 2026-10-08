# Complete the table of contents generator

The package `toc/` prints a table of contents for a Markdown file with `python3 -m toc FILE`. Extend it as below. Use only the Python standard library, keep the tests passing (`python3 -m unittest discover -s tests`) and add tests for what you change.

## Acceptance criteria

1. Setext headings (a line of text followed by a line of `=` characters for level 1, or of `-` characters for level 2) are recognised, and closing hashes of `#` headings (`## Title ##`) are removed. A `#` that is part of a word, as in `## C#`, stays.
2. Headings inside fenced code blocks (``` or ~~~, at least three characters, closed by a line of the same character at least as long) are ignored. Both fence lines may be indented by up to three spaces.
3. Anchors follow GitHub's rules: lower case; characters other than letters, digits, spaces, hyphens and underscores removed (letters outside ASCII are kept); spaces become hyphens; the second and later uses of the same anchor get `-1`, `-2` and so on. As on GitHub, every anchor in the list is different: a number is skipped when that anchor is already taken, so the titles `Usage`, `Usage` and `Usage-1` get `usage`, `usage-1` and `usage-1-1`.
4. `python3 -m toc FILE --max-depth N` keeps levels up to N.
5. `python3 -m toc FILE --write` replaces the lines between the line `<!-- toc -->` and the line `<!-- tocstop -->` with the table of contents, keeps both marker lines, prints nothing, and running it twice gives the same file. Without the markers it prints `No <!-- toc --> marker in FILE` on standard error, where FILE is the path as given, and exits with code 1.
6. Nested entries are indented by two spaces per level below the smallest level present.

`extract_headings(text)` in `toc/headings.py` keeps returning a list of `Heading(level, title)`, with the title as written, without the `#` characters or closing hashes. `render_toc(headings)` in `toc/render.py` keeps returning one line per heading, `- [title](#anchor)`, joined by line breaks without a final one. Without `--write`, the command prints that text followed by one line break.
