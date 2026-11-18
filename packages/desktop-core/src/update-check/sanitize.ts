/** The longest release note text shown; the page says the rest is on the release page. */
export const NOTES_MAX_CHARACTERS = 20_000;

// C0 and C1 controls except tab and newline (carriage returns are turned into newlines before this runs).
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Bidi overrides and isolates (U+202A-202E, U+2066-2069), the marks that do the same job (U+200E, U+200F, U+061C), and
// invisible characters that can hide or fake text (zero-width space, word joiner, BOM, invisible tag characters).
const SPOOFING = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B\u2060\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
// A zero-width joiner stays only between two pictographs (emoji sequences); anywhere else it is a spoofing tool.
const LOOSE_JOINER = /(?<![\p{Extended_Pictographic}️])\u200D|\u200D(?![\p{Extended_Pictographic}])/gu;

export interface SanitizedNotes {
  readonly text: string;
  /** The text was cut at {@link NOTES_MAX_CHARACTERS}. */
  readonly truncated: boolean;
}

/**
 * Release notes are untrusted text: line endings are normalized, control and direction-spoofing characters are removed,
 * and the text is capped. Markup stays as literal characters; the page only ever shows it with `textContent`.
 */
export function sanitizeNotes(raw: string): SanitizedNotes {
  const cleaned = raw
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(CONTROLS, "")
    .replace(SPOOFING, "")
    .replace(LOOSE_JOINER, "");
  if (cleaned.length <= NOTES_MAX_CHARACTERS) return { text: cleaned, truncated: false };
  let end = NOTES_MAX_CHARACTERS;
  // Never leave half of a surrogate pair at the cut.
  const last = cleaned.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: cleaned.slice(0, end), truncated: true };
}
