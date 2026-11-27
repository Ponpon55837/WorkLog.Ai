export type AppliesToGlobToken =
  { kind: "literal"; char: string } | { kind: "one" } | { kind: "segment" } | { kind: "any" };

/**
 * Cost bound: each star keeps a pattern position active across many characters. Writes above it are rejected; stored
 * or imported entries still load and never match.
 */
export const MAX_APPLIES_TO_GLOB_STARS = 16;

/**
 * Write limits. Matching applies them again to stored data, so a longer or surplus entry never matches but still loads
 * unchanged.
 */
export const MAX_APPLIES_TO_ENTRY_LENGTH = 1_000;
export const MAX_APPLIES_TO_ENTRIES = 30;

/**
 * Import bound, wider than the write limits: credential redaction can lengthen an entry (up to about 2.7 times). Such
 * entries import unchanged and never match.
 */
export const MAX_STORED_APPLIES_TO_ENTRIES = 100;
export const MAX_STORED_APPLIES_TO_ENTRY_LENGTH = 4_096;

export const APPLIES_TO_TOKEN_LITERAL = 0;
export const APPLIES_TO_TOKEN_ONE = 1;
export const APPLIES_TO_TOKEN_SEGMENT = 2;
export const APPLIES_TO_TOKEN_ANY = 3;

export const APPLIES_TO_GLOB_STARS_FIX = `Use at most ${MAX_APPLIES_TO_GLOB_STARS} * or ** wildcards per appliesTo glob (adjacent stars count once): split it into narrower globs or list plain paths.`;

const GLOB_CHARACTERS = /[*?]/;

export function isAppliesToGlob(pattern: string): boolean {
  return GLOB_CHARACTERS.test(pattern);
}

export interface CompactAppliesToGlob {
  kinds: Uint8Array;
  codes: Uint16Array;
  length: number;
  stars: number;
}

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

export function tokenizeAppliesToGlob(pattern: string): AppliesToGlobToken[] {
  const { kinds, codes, length } = tokenizeAppliesToGlobCompact(pattern);
  const names = ["literal", "one", "segment", "any"] as const;
  return Array.from({ length }, (_, index) =>
    kinds[index] === APPLIES_TO_TOKEN_LITERAL
      ? { kind: "literal" as const, char: String.fromCharCode(codes[index]!) }
      : { kind: names[kinds[index]!] as "one" | "segment" | "any" },
  );
}

export function appliesToGlobStarCount(tokens: readonly AppliesToGlobToken[]): number {
  let count = 0;
  for (const token of tokens) if (token.kind === "segment" || token.kind === "any") count += 1;
  return count;
}

export function isOverComplexAppliesToGlob(pattern: string): boolean {
  if (!isAppliesToGlob(pattern)) return false;
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
