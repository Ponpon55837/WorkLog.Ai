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

/** How to fix an entry above the bound; validation and update warnings both say it. */
export const APPLIES_TO_GLOB_STARS_FIX = `Use at most ${MAX_APPLIES_TO_GLOB_STARS} * or ** wildcards per appliesTo glob (adjacent stars count once): split it into narrower globs or list plain paths.`;

const GLOB_CHARACTERS = /[*?]/;

/** Whether an appliesTo entry is a glob (matched against the whole path) rather than a plain path. */
export function isAppliesToGlob(pattern: string): boolean {
  return GLOB_CHARACTERS.test(pattern);
}

/** Splits a glob into tokens; two adjacent stars of one kind match exactly what one does, so they become one. */
export function tokenizeAppliesToGlob(pattern: string): AppliesToGlobToken[] {
  const tokens: AppliesToGlobToken[] = [];
  const pushStar = (kind: "segment" | "any"): void => {
    if (tokens.at(-1)?.kind !== kind) tokens.push({ kind });
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      pushStar("any");
      index += pattern[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") {
      pushStar("segment");
    } else if (char === "?") {
      tokens.push({ kind: "one" });
    } else {
      tokens.push({ kind: "literal", char });
    }
  }
  return tokens;
}

/** Star tokens of a tokenized glob, the measure MAX_APPLIES_TO_GLOB_STARS bounds. */
export function appliesToGlobStarCount(tokens: readonly AppliesToGlobToken[]): number {
  let count = 0;
  for (const token of tokens) if (token.kind === "segment" || token.kind === "any") count += 1;
  return count;
}

/** Whether an appliesTo entry is a glob with more stars than matching accepts. */
export function isOverComplexAppliesToGlob(pattern: string): boolean {
  return isAppliesToGlob(pattern) && appliesToGlobStarCount(tokenizeAppliesToGlob(pattern)) > MAX_APPLIES_TO_GLOB_STARS;
}
