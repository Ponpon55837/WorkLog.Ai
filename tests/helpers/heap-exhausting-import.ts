import type { ProjectDataExport } from "../../packages/core/src/index.js";

/** Rows that make the 64 MiB test worker run out of memory in validation, redaction and planning, not in the parse. */
export const HEAP_EXHAUSTING_ROW_COUNT = 110_000;

/**
 * A schema-valid import body about 19 MB long: the work-event row of a real export repeated with unique ids. Its parsed
 * form takes about 20 MiB, which fits a 64 MiB worker, but the copies that validation, redaction and planning make
 * cross the limit in interruptible JavaScript, so the worker ends and the process survives. A body of millions of tiny
 * objects instead exhausts the heap inside the native `JSON.parse`, which V8 cannot interrupt and which aborts the
 * whole process.
 */
export function heapExhaustingImportBytes(
  bundle: ProjectDataExport,
  rows = HEAP_EXHAUSTING_ROW_COUNT,
): Uint8Array<ArrayBuffer> {
  const template = bundle.tables.work_events[0];
  if (!template) throw new Error("The source export needs one work event to replicate.");
  const events = Array.from({ length: rows }, (_, index) => ({ ...template, id: `replica-event-${index}` }));
  return new TextEncoder().encode(
    JSON.stringify({ bundle: { ...bundle, tables: { ...bundle.tables, work_events: events } } }),
  );
}
