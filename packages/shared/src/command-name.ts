import { STANDALONE } from "./database-location.js";

export const STANDALONE_COMMAND_NAME = "work-intelligence";

const STANDALONE_SUBCOMMANDS: Readonly<Record<string, string>> = {
  bootstrap: "setup",
  "setup:agents": "setup-agents",
  "service:install": "service install",
  "service:restart": "service restart",
  "service:uninstall": "service uninstall",
  "service:status": "service status",
  "start:server": "start",
};

export function commandName(script: string, standalone: boolean = STANDALONE): string {
  if (!standalone) return `pnpm ${script}`;
  const subcommand =
    STANDALONE_SUBCOMMANDS[script] ?? (script.startsWith("db:") ? `db ${script.slice("db:".length)}` : script);
  return `${STANDALONE_COMMAND_NAME} ${subcommand}`;
}
