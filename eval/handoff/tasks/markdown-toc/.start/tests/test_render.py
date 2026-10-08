from __future__ import annotations

import unittest

from toc.headings import Heading
from toc.render import render_toc


class RenderTests(unittest.TestCase):
    def test_a_single_top_level_heading_has_a_simple_anchor(self):
        self.assertEqual(render_toc([Heading(1, "Getting started")]),
                         "- [Getting started](#getting-started)")

    def test_a_second_level_heading_is_indented_by_two_spaces(self):
        self.assertEqual(render_toc([Heading(1, "Top"), Heading(2, "Part")]),
                         "- [Top](#top)\n  - [Part](#part)")
