type PageTextBlock =
  { kind: "paragraph"; text: string } | { kind: "list"; ordered: boolean; start: number; items: string[] };

interface TextLine {
  text: string;
  bullet: boolean;
  number?: number;
}

const MAX_CHUNK_WIDTH = 280;
const OPENERS = "\uff08([\u300c\u300e\u3010\u300a";
const CLOSERS = "\uff09)]\u300d\u300f\u3011\u300b";
const CJK_SENTENCE_ENDS = "\u3002\uff01\uff1f\uff1b";
const LATIN_SENTENCE_ENDS = ".!?";
const bulletPattern = /^\s*[-*•]\s+(.*\S)\s*$/;
const numberedPattern = /^\s*(\d{1,3})[.)]\s+(.*\S)\s*$/;

function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-￯]/.test(char) ? 2 : 1;
  return width;
}

function isSentenceEnd(text: string, index: number, requireGap: boolean): boolean {
  const char = text[index] ?? "";
  const next = text[index + 1];
  if (CJK_SENTENCE_ENDS.includes(char)) return !requireGap || next === undefined || /\s/.test(next);
  if (!LATIN_SENTENCE_ENDS.includes(char)) return false;
  if (next === undefined) return true;
  if (!/\s/.test(next)) return false;
  const following = text.slice(index + 1).trimStart()[0];
  return following === undefined || !/[a-z]/.test(following);
}

function splitSentences(text: string, requireGap: boolean): string[] {
  const sentences: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && isSentenceEnd(text, index, requireGap)) {
      const sentence = text.slice(start, index + 1).trim();
      if (sentence) sentences.push(sentence);
      start = index + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

function chunkSentences(text: string): string[] {
  if (textWidth(text) <= MAX_CHUNK_WIDTH) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of splitSentences(text, false)) {
    if (current && textWidth(current + sentence) > MAX_CHUNK_WIDTH) {
      chunks.push(current);
      current = "";
    }
    current += current && /[A-Za-z0-9]$/.test(current) ? ` ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}

function paragraphsOf(line: string): PageTextBlock[] {
  return splitSentences(line, true)
    .flatMap(chunkSentences)
    .map((text) => ({ kind: "paragraph", text }));
}

function parseLine(raw: string): TextLine {
  const bullet = bulletPattern.exec(raw);
  if (bullet) return { text: bullet[1] ?? "", bullet: true };
  const numbered = numberedPattern.exec(raw);
  if (numbered) return { text: numbered[2] ?? "", bullet: false, number: Number(numbered[1]) };
  return { text: raw.trim(), bullet: false };
}

function numberedRunLength(lines: readonly TextLine[], from: number): number {
  const first = lines[from]?.number;
  if (first === undefined) return 0;
  let length = 1;
  while (lines[from + length]?.number === first + length) length += 1;
  return length;
}

/** Splits Knowledge page text into paragraphs and lists at line breaks and sentence ends, for rendering as plain text nodes. */
export function pageTextBlocks(content: string): PageTextBlock[] {
  const blocks: PageTextBlock[] = [];
  const lines = content.split(/\r?\n/).map(parseLine);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line?.text) {
      index += 1;
      continue;
    }
    if (line.bullet) {
      const items: string[] = [];
      while (lines[index]?.bullet) {
        items.push(lines[index]?.text ?? "");
        index += 1;
      }
      blocks.push({ kind: "list", ordered: false, start: 1, items });
      continue;
    }
    const run = numberedRunLength(lines, index);
    if (run >= 2) {
      const items = lines.slice(index, index + run).map((item) => item.text);
      blocks.push({ kind: "list", ordered: true, start: line.number ?? 1, items });
      index += run;
      continue;
    }
    blocks.push(...paragraphsOf(line.number === undefined ? line.text : `${line.number}. ${line.text}`));
    index += 1;
  }
  return blocks;
}
