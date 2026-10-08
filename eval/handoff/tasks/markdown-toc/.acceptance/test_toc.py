from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from toc.headings import Heading, extract_headings
from toc.render import render_toc

ROOT = Path(__file__).resolve().parent.parent


class TocTests(unittest.TestCase):
    def run_command(self, path, *args):
        return subprocess.run(
            [sys.executable, "-m", "toc", str(path), *args],
            cwd=ROOT, capture_output=True, text=True,
        )

    def test_01_setext_headings_have_levels_one_and_two(self):
        result = extract_headings("Title\n=====\n\nPart\n----\n")
        self.assertEqual([(h.level, h.title) for h in result],
                         [(1, "Title"), (2, "Part")])

    def test_02_closing_hashes_are_removed_and_word_hashes_stay(self):
        result = extract_headings("## Usage ##\n### C#\n")
        self.assertEqual([(h.level, h.title) for h in result],
                         [(2, "Usage"), (3, "C#")])

    def test_03_headings_inside_a_backtick_fence_are_ignored(self):
        result = extract_headings("# Before\n```python\n# Hidden\n```\n## After\n")
        self.assertEqual([(h.level, h.title) for h in result],
                         [(1, "Before"), (2, "After")])

    def test_04_headings_inside_a_tilde_fence_are_ignored(self):
        result = extract_headings("~~~\n# Hidden\n~~~\n# Shown\n")
        self.assertEqual([(h.level, h.title) for h in result], [(1, "Shown")])
        indented = extract_headings("   ~~~\n# Hidden\n  ~~~\n# Shown\n")
        self.assertEqual([(h.level, h.title) for h in indented], [(1, "Shown")])

    def test_05_only_a_long_enough_fence_closes_the_block(self):
        result = extract_headings("````\n```\n# hidden\n`````\n# Shown\n")
        self.assertEqual([(h.level, h.title) for h in result], [(1, "Shown")])

    def test_06_punctuation_is_removed_from_anchors(self):
        self.assertEqual(
            render_toc([Heading(1, "Hello, World! (v2.0)")]),
            "- [Hello, World! (v2.0)](#hello-world-v20)",
        )

    def test_07_letters_outside_ascii_are_kept_in_anchors(self):
        self.assertEqual(render_toc([Heading(1, "Café Überblick")]),
                         "- [Café Überblick](#café-überblick)")

    def test_08_duplicate_anchors_are_numbered(self):
        self.assertEqual(
            render_toc([Heading(1, "Usage")] * 3),
            "- [Usage](#usage)\n- [Usage](#usage-1)\n- [Usage](#usage-2)",
        )
        self.assertEqual(
            render_toc([Heading(1, "Usage"), Heading(1, "Usage"), Heading(1, "Usage-1")]),
            "- [Usage](#usage)\n- [Usage](#usage-1)\n- [Usage-1](#usage-1-1)",
        )

    def test_09_maximum_depth_filters_deeper_headings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "doc.md"
            path.write_text("# Top\n## Sub\n### Detail\n", encoding="utf-8")
            result = self.run_command(path, "--max-depth", "2")
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "- [Top](#top)\n  - [Sub](#sub)\n")

    def test_10_write_replaces_only_the_lines_between_markers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "doc.md"
            path.write_text("# Doc\n\n<!-- toc -->\nold line\n<!-- tocstop -->\n\n## Part\n",
                            encoding="utf-8")
            result = self.run_command(path, "--write")
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(
                path.read_text(encoding="utf-8"),
                "# Doc\n\n<!-- toc -->\n- [Doc](#doc)\n  - [Part](#part)\n<!-- tocstop -->\n\n## Part\n",
            )

    def test_11_writing_twice_keeps_the_same_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "doc.md"
            path.write_text("# Doc\n<!-- toc -->\nold\n<!-- tocstop -->\n## Part\n",
                            encoding="utf-8")
            first_run = self.run_command(path, "--write")
            self.assertEqual(first_run.returncode, 0)
            first = path.read_text(encoding="utf-8")
            second_run = self.run_command(path, "--write")
            self.assertEqual(second_run.returncode, 0)
            self.assertEqual(path.read_text(encoding="utf-8"), first)

    def test_12_a_missing_marker_reports_the_given_path_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "doc.md"
            original = "# Doc\n\nA paragraph.\n"
            path.write_text(original, encoding="utf-8")
            result = self.run_command(path, "--write")
            self.assertEqual(result.returncode, 1)
            self.assertIn("No <!-- toc --> marker in " + str(path), result.stderr)
            self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_13_indentation_starts_at_the_smallest_heading_level(self):
        self.assertEqual(
            render_toc([Heading(2, "A"), Heading(3, "B"), Heading(2, "C")]),
            "- [A](#a)\n  - [B](#b)\n- [C](#c)",
        )
