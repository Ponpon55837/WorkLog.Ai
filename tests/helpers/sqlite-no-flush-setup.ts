import { fileURLToPath } from "node:url";

/** Absolute path of the vitest setup file that opens test databases without disk flushes (see sqlite-no-flush.ts). */
export const sqliteNoFlushSetup = fileURLToPath(new URL("./sqlite-no-flush.ts", import.meta.url));
