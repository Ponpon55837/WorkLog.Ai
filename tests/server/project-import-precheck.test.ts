import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  IMPORT_PARSED_BYTES_PER_BYTE,
  IMPORT_PARSED_BYTES_PER_CONTAINER,
  MAX_PROJECT_IMPORT_BYTES,
  MAX_PROJECT_IMPORT_PARSED_HEAP_BYTES,
  RequestBodyError,
  assertProjectImportFitsHeap,
  countJsonContainers,
  estimateProjectImportParsedHeapBytes,
  parseProjectDataImportBytes,
} from "../../apps/server/src/http.js";

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

describe("project import structure precheck", () => {
  it("counts objects and arrays, nesting included", () => {
    expect(countJsonContainers(bytes("{}"))).toBe(1);
    expect(countJsonContainers(bytes('{"a":[{"b":[]},[[]]],"c":{}}'))).toBe(7);
    expect(countJsonContainers(bytes("42"))).toBe(0);
  });

  it("does not count brackets inside strings", () => {
    expect(countJsonContainers(bytes('{"a":"{[{[[["}'))).toBe(1);
    expect(countJsonContainers(bytes('["{","[","}]"]'))).toBe(1);
  });

  it("keeps a string open across escaped quotes and closes it after escaped backslashes", () => {
    // \" does not end the string, so the brackets after it are still text.
    expect(countJsonContainers(bytes('["a\\"[{",{}]'))).toBe(2);
    // \\ is a backslash and the quote after it ends the string, so the following [ counts.
    expect(countJsonContainers(bytes('["a\\\\",[]]'))).toBe(2);
    // Three backslashes: an escaped backslash and an escaped quote, so the string goes on.
    expect(countJsonContainers(bytes('["a\\\\\\"[",{}]'))).toBe(2);
  });

  it("ignores multibyte UTF-8 text", () => {
    expect(countJsonContainers(bytes('{"摘要":"[{ 專案 }]","emoji":"😀{"}'))).toBe(1);
  });

  it("stops at an unterminated string without throwing", () => {
    expect(countJsonContainers(bytes('{"a":"[{'))).toBe(1);
  });

  it("estimates heap as containers times the per-container cost plus the per-byte cost", () => {
    const body = bytes('{"a":[{}]}');
    expect(estimateProjectImportParsedHeapBytes(body)).toBe(
      3 * IMPORT_PARSED_BYTES_PER_CONTAINER + body.byteLength * IMPORT_PARSED_BYTES_PER_BYTE,
    );
  });

  it("accepts a body exactly at the budget and rejects one byte over", () => {
    // Containers cost 72 B each; one byte per remaining character fills the rest of the budget with whitespace.
    const containers = 1000;
    const overhead = containers * IMPORT_PARSED_BYTES_PER_CONTAINER;
    const length = (MAX_PROJECT_IMPORT_PARSED_HEAP_BYTES - overhead) / IMPORT_PARSED_BYTES_PER_BYTE;
    const atBudget = new Uint8Array(length).fill(0x20);
    atBudget.set(bytes("[".repeat(containers)));
    expect(estimateProjectImportParsedHeapBytes(atBudget)).toBe(MAX_PROJECT_IMPORT_PARSED_HEAP_BYTES);
    expect(() => assertProjectImportFitsHeap(atBudget)).not.toThrow();

    const over = new Uint8Array(length).fill(0x20);
    over.set(bytes("[".repeat(containers + 1)));
    expect(() => assertProjectImportFitsHeap(over)).toThrow(RequestBodyError);
    try {
      assertProjectImportFitsHeap(over);
    } catch (error) {
      expect((error as RequestBodyError).statusCode).toBe(413);
    }
  });

  it("rejects the tiny-container shapes that retain 14 to 22 times their size, at the request limit", () => {
    for (const unit of ["{},", "[[]],", "[],"]) {
      const body = bytes(unit.repeat(Math.floor(MAX_PROJECT_IMPORT_BYTES / unit.length)));
      expect(() => assertProjectImportFitsHeap(body)).toThrow(RequestBodyError);
    }
  });

  it("rejects before parsing: a body that is not even JSON still gets 413, and a small invalid one gets 400", () => {
    const hostile = bytes("[".repeat(6_000_000));
    expect(() => parseProjectDataImportBytes(hostile)).toThrow(expect.objectContaining({ statusCode: 413 }));
    expect(() => parseProjectDataImportBytes(bytes("{not json"))).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it("passes a body with realistic density: 50 MiB of text-heavy rows", () => {
    const row = `{"id":"x","summary":"${"文字 ".repeat(60)}"},`;
    const rows = Math.floor(MAX_PROJECT_IMPORT_BYTES / Buffer.byteLength(row));
    const body = bytes(row.repeat(rows));
    expect(() => assertProjectImportFitsHeap(body)).not.toThrow();
  });
});
