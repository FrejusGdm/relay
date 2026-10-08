// Reads the outgoing agent's handoff notes (add-relay-switch, design decision 6). The notes are
// written by an agent, so they are cleaned, cut to 12,000 characters, and only ever placed inside
// the fence in checkpoint.md. Their sections let relay compare claims with facts without a model.
import { removeInvisible } from "../text/invisible";

const SECTIONS = ["Done", "In progress", "Next steps", "Decisions", "Files touched", "Claims to verify", "Problems"] as const;
type Section = (typeof SECTIONS)[number];

export interface Claim {
  text: string;
  // What follows the last "Check:", or "" when the line has none.
  how: string;
}

export interface ParsedNotes {
  // The cleaned notes as they go into checkpoint.md.
  text: string;
  invisibleRemoved: number;
  // False when no line is one of the seven headings; the text is then kept whole.
  structured: boolean;
  // The non-empty lines under each heading.
  sections: Partial<Record<Section, string[]>>;
  claims: Claim[];
}

const LIMIT = 12_000;
// Control characters other than tab and newline.
const CONTROL = /(?![\t\n])\p{Cc}/gu;

export function parseNotes(raw: string): ParsedNotes {
  const { text: visible, removed } = removeInvisible(raw.replace(/\r\n?/g, "\n"));
  const characters = Array.from(visible.replace(CONTROL, "").trim());
  const text = characters.length > LIMIT
    ? `${characters.slice(0, LIMIT).join("")}\n[relay cut the notes here: ${characters.length - LIMIT} more characters]`
    : characters.join("");

  const sections: Partial<Record<Section, string[]>> = {};
  let current: Section | null = null;
  let structured = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      const name = line.slice(3).trim().toLowerCase();
      current = SECTIONS.find((section) => section.toLowerCase() === name) ?? null;
      if (current !== null) {
        structured = true;
        sections[current] ??= [];
      }
      continue;
    }
    if (current !== null && line.trim() !== "") sections[current]!.push(line.trim());
  }
  const claims = (sections["Claims to verify"] ?? []).map(splitClaim);
  return { text, invisibleRemoved: removed, structured, sections, claims };
}

// Splits a claim line at its last "Check:", case-insensitive, after removing a list marker.
function splitClaim(line: string): Claim {
  const item = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
  const at = item.toLowerCase().lastIndexOf("check:");
  if (at === -1) return { text: item.trim(), how: "" };
  return { text: item.slice(0, at).trim(), how: item.slice(at + "check:".length).trim() };
}
