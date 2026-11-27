import { fileURLToPath } from "node:url";

export const isolatedEnvironmentSetup = fileURLToPath(new URL("./isolated-environment.ts", import.meta.url));
