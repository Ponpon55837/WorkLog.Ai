import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STANDALONE } from "@work-intelligence/shared/database-location";

export interface WebDirectoryOptions {
  environment?: NodeJS.ProcessEnv;
  /** Defaults to STANDALONE. */
  standalone?: boolean;
  /** URL of a bundled file under `<package>/libexec/apps/server/dist`; the package's `web/` is found relative to it. */
  moduleUrl?: string;
  /** Injectable for tests. */
  exists?: (path: string) => boolean;
}

/**
 * The built Web UI to serve. WORK_INTELLIGENCE_WEB_DIST always wins (`pnpm start` sets it). Without it a checkout
 * serves no Web UI (the Vite dev server does), while a standalone package serves its own `web/` folder when it is
 * complete.
 */
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
