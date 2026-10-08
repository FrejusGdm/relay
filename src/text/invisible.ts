// The one list of invisible characters for the whole program (design.md decision 4): characters
// that change how text is read or hide text, without showing anything. Checkpoint messages, job
// titles, adapters and handoffs remove them; reports that show names to the person mark them.
// U+061C and U+2028 to U+2029 were added after the review of the trust record, and U+FE00 to
// U+FE0F after the review of the handoff (add-relay-switch).
const INVISIBLE = new RegExp(
  "[" +
    "\\u{00AD}" + // soft hyphen
    "\\u{061C}" + // Arabic letter mark, a direction mark
    "\\u{180E}" + // Mongolian vowel separator
    "\\u{200B}-\\u{200F}" + // zero-width characters and direction marks
    "\\u{2028}-\\u{2029}" + // line and paragraph separators
    "\\u{202A}-\\u{202E}" + // direction embeddings and overrides
    "\\u{2060}-\\u{2064}" + // word joiner and invisible operators
    "\\u{2066}-\\u{2069}" + // direction isolates
    "\\u{FE00}-\\u{FE0F}" + // variation selectors
    "\\u{FEFF}" + // zero-width no-break space
    "\\u{E0000}-\\u{E007F}" + // tag characters, used to hide text
    "\\u{E0100}-\\u{E01EF}" + // variation selectors supplement
    "]",
  "gu",
);

// Replaces each invisible character with what `replace` returns for it.
export function replaceInvisible(text: string, replace: (char: string) => string): string {
  return text.replace(INVISIBLE, replace);
}

export function removeInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  const cleaned = replaceInvisible(text, () => {
    removed++;
    return "";
  });
  return { text: cleaned, removed };
}
