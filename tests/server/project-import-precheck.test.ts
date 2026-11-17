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
    const budget = 4096;
    const containers = 10;
    const overhead = containers * IMPORT_PARSED_BYTES_PER_CONTAINER;
    const length = (budget - overhead) / IMPORT_PARSED_BYTES_PER_BYTE;
    const atBudget = new Uint8Array(length).fill(0x20);
    atBudget.set(bytes("[".repeat(containers)));
    expect(estimateProjectImportParsedHeapBytes(atBudget)).toBe(budget);
    expect(() => assertProjectImportFitsHeap(atBudget, budget)).not.toThrow();

    const over = new Uint8Array(length).fill(0x20);
    over.set(bytes("[".repeat(containers + 1)));
    expect(() => assertProjectImportFitsHeap(over, budget)).toThrow(RequestBodyError);
    try {
      assertProjectImportFitsHeap(over, budget);
    } catch (error) {
      expect((error as RequestBodyError).statusCode).toBe(413);
    }
  });

  it("estimates the tiny-container shapes at a cost that rejects 50 MiB of them", () => {
    // Arithmetic on a small sample: the estimate is linear, so the per-byte cost times the request limit is the cost
    // of a full-size body of the same shape.
    for (const unit of ["{},", "[[]],", "[],"]) {
      const body = bytes(unit.repeat(4000));
      const perByte = estimateProjectImportParsedHeapBytes(body) / body.byteLength;
      expect(perByte * MAX_PROJECT_IMPORT_BYTES).toBeGreaterThan(MAX_PROJECT_IMPORT_PARSED_HEAP_BYTES);
      expect(() => assertProjectImportFitsHeap(body, 1024)).toThrow(RequestBodyError);
    }
  });

  it("rejects before parsing: a body that is not even JSON still gets 413, and a small invalid one gets 400", () => {
    // 74 B per `[` (72 + 2), so this exceeds the default budget while staying cheap to scan.
    const hostile = bytes("[".repeat(Math.ceil(MAX_PROJECT_IMPORT_PARSED_HEAP_BYTES / 74) + 1));
    expect(() => parseProjectDataImportBytes(hostile)).toThrow(expect.objectContaining({ statusCode: 413 }));
    expect(() => parseProjectDataImportBytes(bytes("{not json"))).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it("passes a body with realistic density: text-heavy rows", () => {
    const row = `{"id":"x","summary":"${"文字 ".repeat(60)}"},`;
    const body = bytes(row.repeat(1000));
    expect(estimateProjectImportParsedHeapBytes(body) / body.byteLength).toBeLessThan(
      MAX_PROJECT_IMPORT_PARSED_HEAP_BYTES / MAX_PROJECT_IMPORT_BYTES,
    );
    expect(() => assertProjectImportFitsHeap(body)).not.toThrow();
  });
});
