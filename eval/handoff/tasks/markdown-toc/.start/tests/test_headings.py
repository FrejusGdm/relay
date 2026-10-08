from __future__ import annotations

import unittest

from toc.headings import extract_headings


class HeadingTests(unittest.TestCase):
    def test_hash_headings_keep_their_levels_and_titles(self):
        result = extract_headings("# Top\n## Part\n### Detail\n")
        self.assertEqual([(h.level, h.title) for h in result],
                         [(1, "Top"), (2, "Part"), (3, "Detail")])

    def test_text_without_headings_gives_an_empty_list(self):
        self.assertEqual(extract_headings("A paragraph.\nAnother paragraph.\n"), [])
