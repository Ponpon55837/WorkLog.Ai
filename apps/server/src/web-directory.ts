import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STANDALONE } from "@work-intelligence/shared/database-location";

export interface WebDirectoryOptions {
  environment?: NodeJS.ProcessEnv;
  standalone?: boolean;
  moduleUrl?: string;
  exists?: (path: string) => boolean;
}

export function resolveWebDirectory({
  environment = process.env,
  standalone = STANDALONE,
  moduleUrl = import.meta.url,
  exists = existsSync,
}: WebDirectoryOptions = {}): string | undefined {
  const configured = environment.WORK_INTELLIGENCE_WEB_DIST;
  if (configured) return configured;
  if (!standalone) return undefined;
  // <package>/libexec/apps/server/dist/<file>.js  ->  <package>/web
  const packaged = resolve(dirname(fileURLToPath(moduleUrl)), "../../../../web");
  return exists(resolve(packaged, "index.html")) ? packaged : undefined;
}
