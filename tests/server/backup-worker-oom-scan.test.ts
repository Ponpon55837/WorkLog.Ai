import { describe, expect, it } from "vitest";
import { createOutOfMemoryScanner } from "../../apps/server/src/backup-worker-client.js";

/** A synthetic native stack frame like the ones V8 prints after its out-of-memory report. */
function frame(index: number): string {
  return ` ${index}: 0x1006d2b24 v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace, v8::internal::GarbageCollectionReason, v8::GCCallbackFlags) [/fictional/node]\n`;
}

/** A stack trace of more than `bytes` characters. */
function stackTrace(bytes: number): string {
  let text = "----- Native stack trace -----\n\n";
  for (let index = 1; text.length <= bytes; index += 1) text += frame(index);
  return text;
}

function scanAll(chunks: readonly string[]): boolean {
  const scanner = createOutOfMemoryScanner();
  for (const chunk of chunks) scanner.scan(chunk);
  return scanner.seen;
}

describe("the background worker's out-of-memory scanner", () => {
  it("recognises the report although a native stack trace longer than 8 KiB follows it", () => {
    // On macOS arm64 the trace after the report ran to about 10 KB, past the 8 KiB tail that used to be searched.
    const report =
      "\n<--- Last few GCs --->\n\nFATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n";
    const trace = stackTrace(16 * 1024);
    expect(scanAll([report + trace])).toBe(true);
    expect(scanAll([report, ...trace.match(/[^\n]*\n/g)!])).toBe(true);
  });

  it.each([
    "JavaScript heap out of memory",
    "Reached heap limit",
    "Allocation failed",
    "Fatal JavaScript out of memory",
  ])("recognises %s, also when it is split across two chunks", (marker) => {
    expect(scanAll([`FATAL ERROR: ${marker}\n`])).toBe(true);
    for (let cut = 1; cut < marker.length; cut += 1) {
      expect(scanAll([`FATAL ERROR: ${marker.slice(0, cut)}`, `${marker.slice(cut)}\n${stackTrace(10_000)}`])).toBe(
        true,
      );
    }
  });

  it("does not classify other exits, and does not carry a report from one process to another", () => {
    expect(scanAll([stackTrace(10_000), "Error: something else went wrong\n"])).toBe(false);
    expect(scanAll(["JavaScript heap ", "\n".repeat(400), "out of memory"])).toBe(false);
    const first = createOutOfMemoryScanner();
    first.scan("FATAL ERROR: Reached heap limit\n");
    expect(first.seen).toBe(true);
    expect(createOutOfMemoryScanner().seen).toBe(false);
  });
});
