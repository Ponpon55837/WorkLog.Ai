import { fileURLToPath } from "node:url";

/** Absolute path of the shared vitest setup file; every vitest config registers it in `test.setupFiles`. */
export const isolatedEnvironmentSetup = fileURLToPath(new URL("./isolated-environment.ts", import.meta.url));
