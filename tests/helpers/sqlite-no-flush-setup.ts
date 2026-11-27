import { fileURLToPath } from "node:url";

export const sqliteNoFlushSetup = fileURLToPath(new URL("./sqlite-no-flush.ts", import.meta.url));
