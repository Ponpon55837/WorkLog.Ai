import { STANDALONE } from "./database-location.js";

/** The command a standalone package installs (package.json `bin`). */
export const STANDALONE_COMMAND_NAME = "work-intelligence";

/** Root package scripts whose standalone subcommand is not simply the script name or `db <name>`. */
const STANDALONE_SUBCOMMANDS: Readonly<Record<string, string>> = {
  bootstrap: "setup",
  "setup:agents": "setup-agents",
  "service:install": "service install",
  "service:restart": "service restart",
  "service:uninstall": "service uninstall",
  "service:status": "service status",
  "start:server": "start",
};

/**
 * The command a person types for a root package script, as shown in messages: `pnpm db:backup` in a checkout,
 * `work-intelligence db backup` in a standalone package. The single place that knows both spellings.
 */
export function commandName(script: string, standalone: boolean = STANDALONE): string {
  if (!standalone) return `pnpm ${script}`;
  const subcommand =
    STANDALONE_SUBCOMMANDS[script] ?? (script.startsWith("db:") ? `db ${script.slice("db:".length)}` : script);
  return `${STANDALONE_COMMAND_NAME} ${subcommand}`;
}
