import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { extractClaudeLine, isClaudeLine } from "./claude.js";
import { isCodexLine } from "./codex.js";
import { checkScanLimits } from "./errors.js";
import { isRecord } from "./metrics.js";
import type { ClaudeRecord } from "./types.js";

/** Records and counters of lines that were read in this pass. */
interface ExtractedLines {
  records: ClaudeRecord[];
  skippedLines: number;
  codexLines: number;
}

export interface ExtractResult extends ExtractedLines {
  /** Byte offset just after the last newline; the next incremental read starts here. */
  offset: number;
  /** The unterminated last line, parsed for the report but not covered by `offset`. */
  tail: ExtractedLines;
  /** Bytes read from disk. */
  bytesRead: number;
}

interface ExtractOptions {
  /** Byte offset to start reading at (a line start). */
  start?: number;
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Receives every parsed line the Claude Code parser does not own but the Codex parser does. */
  onCodexLine?: (line: Record<string, any>) => void;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const CHUNK_BYTES = 256 * 1024;
const LIMIT_CHECK_LINES = 256;

function emptyLines(): ExtractedLines {
  return { records: [], skippedLines: 0, codexLines: 0 };
}

/**
 * Phase one for one file: streams it as Buffers, splits on newlines while tracking exact byte offsets, and turns every
 * Claude Code line into a compact record. Handles CRLF; an unterminated last line goes to `tail`, never into `offset`.
 */
export async function extractFile(path: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  const { signal, deadlineMs, onCodexLine } = options;
  const start = options.start ?? 0;
  const main = emptyLines();
  const strings = new Map<string, string>();
  const intern = (value: string): string => {
    const known = strings.get(value);
    if (known !== undefined) return known;
    strings.set(value, value);
    return value;
  };
  const consume = (target: ExtractedLines, bytes: Buffer): void => {
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === CARRIAGE_RETURN) end -= 1;
    const text = bytes.toString("utf8", 0, end);
    if (text.trim() === "") return;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      target.skippedLines += 1;
      return;
    }
    if (!isRecord(line)) {
      target.skippedLines += 1;
      return;
    }
    if (isClaudeLine(line)) target.records.push(extractClaudeLine(line, intern));
    // Lines of other types (attachment, summary, ...) match no parser and are ignored.
    else if (isCodexLine(line)) {
      target.codexLines += 1;
      onCodexLine?.(line);
    }
  };

  let offset = start;
  let bytesRead = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let lineCount = 0;
  checkScanLimits(signal, deadlineMs);
  const stream = createReadStream(path, { start, highWaterMark: CHUNK_BYTES });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      checkScanLimits(signal, deadlineMs);
      bytesRead += chunk.length;
      let from = 0;
      for (;;) {
        const newline = chunk.indexOf(NEWLINE, from);
        if (newline === -1) {
          if (from < chunk.length) {
            const rest = from === 0 ? chunk : chunk.subarray(from);
            pending.push(rest);
            pendingBytes += rest.length;
          }
          break;
        }
        const part = chunk.subarray(from, newline);
        const bytes = pending.length === 0 ? part : Buffer.concat([...pending, part]);
        offset += pendingBytes + part.length + 1;
        pending = [];
        pendingBytes = 0;
        consume(main, bytes);
        from = newline + 1;
        lineCount += 1;
        if (lineCount % LIMIT_CHECK_LINES === 0) checkScanLimits(signal, deadlineMs);
      }
    }
  } finally {
    stream.destroy();
  }
  const tail = emptyLines();
  if (pending.length > 0) consume(tail, Buffer.concat(pending));
  return { ...main, codexLines: main.codexLines + tail.codexLines, offset, tail, bytesRead };
}
