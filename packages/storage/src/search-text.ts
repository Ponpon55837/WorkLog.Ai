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
const LOWERED_ROOT_LIMIT = 64;
const loweredRoots = new Map<string, string>();

/** `value.replace(/\/+$/, "")` in one backward pass: the RegExp retries from every slash of a run (quadratic). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** A project root as normalizePath compares it, remembered for the few roots a process sees (bounded). */
function loweredRoot(rootPath: string): string {
  let root = loweredRoots.get(rootPath);
  if (root === undefined) {
    if (loweredRoots.size >= LOWERED_ROOT_LIMIT) loweredRoots.clear();
    root = trimTrailingSlashes(rootPath.replace(/\\/g, "/")).toLowerCase();
    loweredRoots.set(rootPath, root);
  }
  return root;
}

function isLineTerminatorCode(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

/**
 * `value.replace(/#L\d+.*$/i, "")` in linear time; the RegExp backtracks through `\d+` and `.*` from every `#L`
 * (quadratic on a long digit run). It matches at the first `#`, `L` or `l`, digit whose tail holds no line terminator:
 * `\d+.*` is then any non-empty run of non-terminators to the end, and none can start earlier, because an earlier
 * start would need the terminator after it to be inside that run.
 */
function stripLineAnchor(value: string): string {
  let from = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (isLineTerminatorCode(value.charCodeAt(index))) {
      from = index + 1;
      break;
    }
  }
  for (let index = from; index + 2 < value.length; index += 1) {
    if (value.charCodeAt(index) !== 35) continue;
    const letter = value.charCodeAt(index + 1);
    const digit = value.charCodeAt(index + 2);
    if ((letter === 76 || letter === 108) && digit >= 48 && digit <= 57) return value.slice(0, index);
  }
  return value;
}

/**
 * Normalizes a stored or queried path for suffix matching: forward slashes, lower case, no line
 * suffix, and relative to the project when it carries the project root or a `<projectName>/` prefix.
 */
export function normalizePath(raw: string, projects: PathContext[] = []): string {
  // Each replace runs only when its pattern can match (same result, measured 2x faster on 100,000 paths): a
  // backslash, a leading `./`, and a trailing `:line` or `:line:column` that must end in a digit.
  let value = raw.trim();
  if (value.includes("\\")) value = value.replace(/\\/g, "/");
  if (value.startsWith("./")) value = value.slice(2);
  value = stripLineAnchor(value);
  const last = value.charCodeAt(value.length - 1);
  if (last >= 48 && last <= 57) value = value.replace(/:\d+(?::\d+)?$/, "");
  const lower = value.toLowerCase();
  for (const project of projects) {
    const root = loweredRoot(project.rootPath);
    if (root && (lower === root || lower.startsWith(`${root}/`))) {
      return trimTrailingSlashes(lower.slice(root.length + 1));
    }
  }
  for (const project of projects) {
    const name = project.name.toLowerCase();
    if (name && lower.startsWith(`${name}/`)) {
      return trimTrailingSlashes(lower.slice(name.length + 1));
    }
  }
  return trimTrailingSlashes(lower);
}

/**
 * The same project-relative path as normalizePath, keeping the original letter case, for display. Returns
 * undefined when lower-casing changes the length, so callers fall back to the normalized path.
 */
export function projectRelativePath(raw: string, projects: PathContext[] = []): string | undefined {
  let value = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  value = trimTrailingSlashes(stripLineAnchor(value).replace(/:\d+(?::\d+)?$/, ""));
  const lower = value.toLowerCase();
  if (lower.length !== value.length) {
    return undefined;
  }
  for (const project of projects) {
    const root = trimTrailingSlashes(project.rootPath.replace(/\\/g, "/")).toLowerCase();
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

export function pathBasename(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}
