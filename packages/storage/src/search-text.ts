/*
 * Text handling for the retrieval index. Latin text is split into words (identifiers also into their
 * camelCase/snake_case parts); CJK runs become overlapping bigrams, so a two-character Chinese word is
 * one exact token and longer runs match without a word segmenter. Index and query share this tokenizer.
 */

const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const TOKEN_RUN = new RegExp(`([${CJK_CLASS}]+)|((?:(?![${CJK_CLASS}])[\\p{L}\\p{N}])+)`, "gu");

// Dropped from queries only; the index keeps them so document statistics stay honest.
const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "什麼",
  "為什",
  "怎麼",
  "如何",
  "哪裡",
  "哪些",
  "我們",
  "這個",
  "那個",
  "一個",
  "可以",
  "是否",
  "有沒",
  "沒有",
  "的問",
]);

function splitIdentifier(run: string): string[] {
  return run
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(" ");
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.normalize("NFKC").matchAll(TOKEN_RUN)) {
    const [, cjk, word] = match;
    if (cjk) {
      const chars = Array.from(cjk);
      if (chars.length === 1) {
        tokens.push(cjk);
        continue;
      }
      for (let index = 0; index < chars.length - 1; index += 1) {
        tokens.push(`${chars[index]}${chars[index + 1]}`);
      }
    } else if (word) {
      const whole = word.toLowerCase();
      if (whole.length >= 2) {
        tokens.push(whole);
      }
      const parts = splitIdentifier(word);
      if (parts.length > 1) {
        for (const part of parts) {
          if (part.length >= 2) {
            tokens.push(part.toLowerCase());
          }
        }
      }
    }
  }
  return tokens;
}

export interface QueryWord {
  word: string;
  terms: string[];
}

/** Splits a free-text query into whitespace words, each with its de-duplicated, stopword-free terms. */
export function parseQueryWords(query: string): QueryWord[] {
  const words: QueryWord[] = [];
  for (const word of query.split(/[\s,;，；、。]+/u)) {
    const terms = [...new Set(tokenize(word))].filter((term) => !QUERY_STOPWORDS.has(term));
    if (terms.length > 0) {
      words.push({ word, terms });
    }
  }
  return words;
}

/** FTS5 match expression for one term; longer Latin words also match as a prefix (plurals, suffixes). */
export function ftsTermExpression(term: string): string {
  return /^[a-z0-9]{4,}$/.test(term) ? `"${term}"*` : `"${term}"`;
}

export interface MarkdownSection {
  heading: string;
  content: string;
}

/** Splits Markdown by `#`–`###` headings outside code fences; text before the first heading has an empty heading. */
export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let heading = "";
  let lines: string[] = [];
  let inFence = false;
  const flush = () => {
    const content = lines.join("\n").trim();
    if (content.length > 0) {
      sections.push({ heading, content });
    }
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    const headingMatch = inFence ? null : /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      flush();
      heading = headingMatch[1] ?? "";
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

export function excerptAround(text: string, terms: string[], maxLength = 220): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const lower = collapsed.toLowerCase();
  let position = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (position < 0 || found < position)) {
      position = found;
    }
  }
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  const start = Math.max(
    0,
    Math.min(position < 0 ? 0 : position - Math.floor(maxLength / 3), collapsed.length - maxLength),
  );
  const slice = collapsed.slice(start, start + maxLength);
  return `${start > 0 ? "…" : ""}${slice}${start + maxLength < collapsed.length ? "…" : ""}`;
}

export type ReferenceKind = "path" | "commit" | "url";

export interface NormalizedReference {
  kind: ReferenceKind;
  value: string;
}

export interface PathContext {
  name: string;
  rootPath: string;
}

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalizes a stored or queried path for suffix matching: forward slashes, lower case, no line
 * suffix, and relative to the project when it carries the project root or a `<projectName>/` prefix.
 */
export function normalizePath(raw: string, projects: PathContext[] = []): string {
  let value = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  value = value.replace(/#L\d+.*$/i, "").replace(/:\d+(?::\d+)?$/, "");
  const lower = value.toLowerCase();
  for (const project of projects) {
    const root = project.rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (root && (lower === root || lower.startsWith(`${root}/`))) {
      return lower.slice(root.length + 1).replace(/\/+$/, "");
    }
  }
  for (const project of projects) {
    const name = project.name.toLowerCase();
    if (name && lower.startsWith(`${name}/`)) {
      return lower.slice(name.length + 1).replace(/\/+$/, "");
    }
  }
  return lower.replace(/\/+$/, "");
}

/**
 * The same project-relative path as normalizePath, keeping the original letter case, for display. Returns
 * undefined when lower-casing changes the length, so callers fall back to the normalized path.
 */
export function projectRelativePath(raw: string, projects: PathContext[] = []): string | undefined {
  let value = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  value = value
    .replace(/#L\d+.*$/i, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/\/+$/, "");
  const lower = value.toLowerCase();
  if (lower.length !== value.length) {
    return undefined;
  }
  for (const project of projects) {
    const root = project.rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (root && lower.startsWith(`${root}/`)) {
      return value.slice(root.length + 1);
    }
  }
  for (const project of projects) {
    const name = project.name.toLowerCase();
    if (name && lower.startsWith(`${name}/`)) {
      return value.slice(name.length + 1);
    }
  }
  return value;
}

/** Splits a Knowledge reference into its commit SHAs, URLs, and normalized paths. */
export function normalizeReference(reference: string, projects: PathContext[] = []): NormalizedReference[] {
  const results: NormalizedReference[] = [];
  for (const part of reference.split(/\s+|[(),]|@(?=[0-9a-f]{7,40}\b)/i)) {
    const value = part.trim();
    if (!value) {
      continue;
    }
    if (COMMIT_SHA.test(value)) {
      results.push({ kind: "commit", value: value.toLowerCase() });
    } else if (URL_PATTERN.test(value)) {
      results.push({ kind: "url", value });
    } else if (/[/\\.]/.test(value)) {
      const path = normalizePath(value, projects);
      if (path) {
        results.push({ kind: "path", value: path });
      }
    }
  }
  return results;
}

/**
 * Match strength between a stored path and a queried path (both normalized): 1 exact, 0.8 when one
 * is a path-segment suffix of the other, 0.6 when the stored path is inside a queried directory.
 */
export function pathMatchStrength(stored: string, queried: string): number {
  if (!stored || !queried) {
    return 0;
  }
  if (stored === queried) {
    return 1;
  }
  if (stored.endsWith(`/${queried}`) || queried.endsWith(`/${stored}`)) {
    return 0.8;
  }
  if (stored.startsWith(`${queried}/`) || stored.includes(`/${queried}/`)) {
    return 0.6;
  }
  return 0;
}

/**
 * One step of a compiled appliesTo glob: a literal code unit, `?` (one character other than `/`), `*` (any run
 * without `/`), or `**` (any run, `/` included). A `/` right after `**` belongs to it, so `src/**` followed by
 * `/x.ts` also matches `src/x.ts`.
 */
type GlobToken = { kind: "literal"; char: string } | { kind: "one" } | { kind: "segment" } | { kind: "any" };

/**
 * Knowledge rows one appliesTo scan reads at most, newest first: the scans run in memory on caller-supplied paths,
 * so their cost stays bounded however many Knowledge items the tracked projects hold.
 */
export const APPLIES_TO_SCAN_LIMIT = 2_000;

// Staleness checks test the same few appliesTo globs against every changed file of every later Session,
// so compile each glob once. The bound only guards against unbounded growth; real projects use a handful.
const GLOB_CACHE_LIMIT = 512;
const globCache = new Map<string, GlobToken[]>();

function compileGlob(pattern: string): GlobToken[] {
  const cached = globCache.get(pattern);
  if (cached) {
    return cached;
  }
  const tokens: GlobToken[] = [];
  const pushStar = (kind: "segment" | "any"): void => {
    // Two adjacent stars of one kind match exactly what one does, so keep one: fewer states, same answers.
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
  if (globCache.size >= GLOB_CACHE_LIMIT) {
    globCache.clear();
  }
  globCache.set(pattern, tokens);
  return tokens;
}

/** Characters `.` in a JavaScript RegExp without the `s` flag does not match; `**` has always excluded them. */
function isLineTerminator(char: string): boolean {
  return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";
}

/**
 * Whole-string glob match by simulating every pattern position at once (a Thompson-style NFA walk), so a stored
 * pattern full of stars costs O(pattern x path) in the worst case instead of exponential regex backtracking.
 * Works on UTF-16 code units, like the anchored RegExp it replaced.
 */
function globMatches(tokens: readonly GlobToken[], path: string): boolean {
  const accept = tokens.length;
  let active = new Uint8Array(accept + 1);
  let next = new Uint8Array(accept + 1);
  // A star may match nothing, so each active star also activates the position after it.
  const close = (states: Uint8Array): void => {
    for (let index = 0; index < accept; index += 1) {
      const kind = tokens[index]!.kind;
      if (states[index] && (kind === "segment" || kind === "any")) states[index + 1] = 1;
    }
  };
  active[0] = 1;
  close(active);
  for (let offset = 0; offset < path.length; offset += 1) {
    const char = path[offset]!;
    next.fill(0);
    let alive = false;
    for (let index = 0; index < accept; index += 1) {
      if (!active[index]) continue;
      const token = tokens[index]!;
      if (token.kind === "literal") {
        if (token.char === char) next[index + 1] = 1;
      } else if (token.kind === "one") {
        if (char !== "/") next[index + 1] = 1;
      } else if (token.kind === "segment") {
        if (char !== "/") next[index] = 1;
      } else if (!isLineTerminator(char)) {
        next[index] = 1;
      }
    }
    close(next);
    for (let index = 0; index <= accept; index += 1) alive ||= next[index] === 1;
    if (!alive) return false;
    [active, next] = [next, active];
  }
  return active[accept] === 1;
}

/**
 * Whether a normalized changed-file path falls under a normalized appliesTo entry: a glob
 * (`*`, `**`, `?`) must match the whole path; a plain path matches itself, files under it as a
 * directory, or a path-segment suffix.
 */
export function matchesAppliesTo(path: string, pattern: string): boolean {
  return compileAppliesTo(pattern)(path);
}

/** Precompiles a normalized appliesTo entry into a matcher, for checking one pattern against many paths. */
export function compileAppliesTo(pattern: string): (path: string) => boolean {
  if (!pattern) {
    return () => false;
  }
  if (/[*?]/.test(pattern)) {
    const glob = compileGlob(pattern);
    return (path) => Boolean(path) && globMatches(glob, path);
  }
  return (path) => Boolean(path) && pathMatchStrength(path, pattern) > 0;
}

/**
 * How strongly a normalized appliesTo entry covers a normalized path, the rule work_recall ranks by: a glob matching
 * the whole path 0.8; a plain entry equal to it 1, either one a path-segment suffix of the other 0.8, either one a
 * directory containing the other 0.6; otherwise 0.
 */
export function appliesToStrength(pattern: string, path: string): number {
  if (/[*?]/.test(pattern)) {
    return compileAppliesTo(pattern)(path) ? 0.8 : 0;
  }
  return Math.max(pathMatchStrength(pattern, path), pathMatchStrength(path, pattern));
}

export function pathBasename(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}
