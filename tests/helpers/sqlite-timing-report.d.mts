/** The lines the CI report prints for the given JSONL records (see sqlite-timing-report.mjs). */
export function sqliteTimingReport(records: ReadonlyArray<Record<string, unknown>>): string[];
