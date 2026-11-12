/**
 * appliesTo glob syntax, shared by write-time validation (packages/schema) and matching (packages/storage) so both
 * read a pattern the same way.
 */

/**
 * One step of a tokenized appliesTo glob: a literal code unit, `?` (one character other than `/`), `*` (any run
 * without `/`), or `**` (any run, `/` included). A `/` right after `**` belongs to it, so `src/**` followed by
 * `/x.ts` also matches `src/x.ts`.
 */
export type AppliesToGlobToken =
  { kind: "literal"; char: string } | { kind: "one" } | { kind: "segment" } | { kind: "any" };

/**
 * Most star tokens (`*` or `**`, after adjacent stars of one kind are folded into one) an appliesTo glob may have.
 * Stars are what let one pattern position stay active across many path characters, so they decide how much a
 * match can cost. Every glob in a copy of real data has one star, and hand-written scopes such as "every service file
 * under any package's src" need three, so 16 sits far above legitimate use. New entries above it are rejected at
 * write time; stored or imported ones still load and never match.
 */
export const MAX_APPLIES_TO_GLOB_STARS = 16;

/**
 * Characters one appliesTo entry may have, and entries one record may keep: the limits writes enforce. Matching applies
 * them again to whatever is stored (an import, or an older build), so a longer entry, or one past the first
 * MAX_APPLIES_TO_ENTRIES, never matches and is never tokenized; the stored row still loads and shows unchanged.
 */
export const MAX_APPLIES_TO_ENTRY_LENGTH = 1_000;
export const MAX_APPLIES_TO_ENTRIES = 30;

/**
 * The structural bound portable import applies to a stored appliesTo list, deliberately wider than the write limits:
 * credential redaction replaces a short secret with a longer marker (an 8-character connection-string password
 * becomes the 37-character `[REDACTED:connection_string_password]`), so a valid 1,000-character entry can be stored
 * at up to about 2.7 times that, and older versions may have stored values the current write rules would refuse.
 * Such entries import unchanged and never match. Only a list beyond these bounds, which no version writes, is refused.
 */
export const MAX_STORED_APPLIES_TO_ENTRIES = 100;
export const MAX_STORED_APPLIES_TO_ENTRY_LENGTH = 4_096;

/** Token kinds of the compact form: one byte per token. */
export const APPLIES_TO_TOKEN_LITERAL = 0;
export const APPLIES_TO_TOKEN_ONE = 1;
export const APPLIES_TO_TOKEN_SEGMENT = 2;
export const APPLIES_TO_TOKEN_ANY = 3;

/** How to fix an entry above the bound; validation and update warnings both say it. */
export const APPLIES_TO_GLOB_STARS_FIX = `Use at most ${MAX_APPLIES_TO_GLOB_STARS} * or ** wildcards per appliesTo glob (adjacent stars count once): split it into narrower globs or list plain paths.`;

const GLOB_CHARACTERS = /[*?]/;

/** Whether an appliesTo entry is a glob (matched against the whole path) rather than a plain path. */
export function isAppliesToGlob(pattern: string): boolean {
  return GLOB_CHARACTERS.test(pattern);
}

/**
 * A glob as two parallel typed arrays (kind per token; the code unit of a literal, 0 otherwise), built in one pass
 * of the pattern with no object per character. `onChar`, when given, is called once per pattern code unit read, so a
 * caller can count the work.
 */
export interface CompactAppliesToGlob {
  kinds: Uint8Array;
  codes: Uint16Array;
  length: number;
  stars: number;
}

/** Splits a glob into compact tokens; two adjacent stars of one kind match exactly what one does, so they become one. */
export function tokenizeAppliesToGlobCompact(pattern: string): CompactAppliesToGlob {
  const kinds = new Uint8Array(pattern.length);
  const codes = new Uint16Array(pattern.length);
  let length = 0;
  let stars = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const code = pattern.charCodeAt(index);
    let kind = APPLIES_TO_TOKEN_LITERAL;
    if (code === 42 && pattern.charCodeAt(index + 1) === 42) {
      kind = APPLIES_TO_TOKEN_ANY;
      index += pattern.charCodeAt(index + 2) === 47 ? 2 : 1;
    } else if (code === 42) {
      kind = APPLIES_TO_TOKEN_SEGMENT;
    } else if (code === 63) {
      kind = APPLIES_TO_TOKEN_ONE;
    }
    if (kind === APPLIES_TO_TOKEN_SEGMENT || kind === APPLIES_TO_TOKEN_ANY) {
      if (length > 0 && kinds[length - 1] === kind) continue;
      stars += 1;
    }
    kinds[length] = kind;
    codes[length] = kind === APPLIES_TO_TOKEN_LITERAL ? code : 0;
    length += 1;
  }
  return { kinds, codes, length, stars };
}

/** Splits a glob into tokens; two adjacent stars of one kind match exactly what one does, so they become one. */
export function tokenizeAppliesToGlob(pattern: string): AppliesToGlobToken[] {
  const { kinds, codes, length } = tokenizeAppliesToGlobCompact(pattern);
  const names = ["literal", "one", "segment", "any"] as const;
  return Array.from({ length }, (_, index) =>
    kinds[index] === APPLIES_TO_TOKEN_LITERAL
      ? { kind: "literal" as const, char: String.fromCharCode(codes[index]!) }
      : { kind: names[kinds[index]!] as "one" | "segment" | "any" },
  );
}

/** Star tokens of a tokenized glob, the measure MAX_APPLIES_TO_GLOB_STARS bounds. */
export function appliesToGlobStarCount(tokens: readonly AppliesToGlobToken[]): number {
  let count = 0;
  for (const token of tokens) if (token.kind === "segment" || token.kind === "any") count += 1;
  return count;
}

/** Whether an appliesTo entry is a glob with more stars than matching accepts. */
export function isOverComplexAppliesToGlob(pattern: string): boolean {
  if (!isAppliesToGlob(pattern)) return false;
  // The same folding as tokenizeAppliesToGlobCompact, without allocating: write-time validation may see any length.
  let stars = 0;
  let previous = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    const code = pattern.charCodeAt(index);
    let kind = APPLIES_TO_TOKEN_LITERAL;
    if (code === 42 && pattern.charCodeAt(index + 1) === 42) {
      kind = APPLIES_TO_TOKEN_ANY;
      index += pattern.charCodeAt(index + 2) === 47 ? 2 : 1;
    } else if (code === 42) {
      kind = APPLIES_TO_TOKEN_SEGMENT;
    } else if (code === 63) {
      kind = APPLIES_TO_TOKEN_ONE;
    }
    if ((kind === APPLIES_TO_TOKEN_SEGMENT || kind === APPLIES_TO_TOKEN_ANY) && kind !== previous) stars += 1;
    previous = kind;
  }
  return stars > MAX_APPLIES_TO_GLOB_STARS;
}
