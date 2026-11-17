import { LEGACY_LAUNCHD_LABEL, LEGACY_SYSTEMD_UNIT, legacyWindowsTaskTarget } from "./constants.js";
import type { LegacyServicePlatform } from "./types.js";

/** POSIX shells: single quotes keep `$`, backticks, `!` and spaces literal. */
export function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** PowerShell: single quotes are literal; the typographic quotes PowerShell also treats as quotes are doubled too. */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

/** `cd` into the checkout and run the supported uninstaller (which also stops the runner it started). */
export function legacyRemoveCommand(platform: LegacyServicePlatform, repositoryRoot: string): string {
  if (platform === "win32") {
    return `Set-Location -LiteralPath ${quotePowerShell(repositoryRoot)}; pnpm service:uninstall`;
  }
  return `cd ${quotePosixShell(repositoryRoot)} && pnpm service:uninstall`;
}

/** The raw OS commands, for when the checkout is gone or the definition is not the one `service:install` writes. */
export function legacyFallbackRemoveCommand(platform: LegacyServicePlatform, definitionFile: string): string {
  if (platform === "darwin") {
    return `launchctl bootout "gui/$(id -u)/${LEGACY_LAUNCHD_LABEL}"; rm -f ${quotePosixShell(definitionFile)}`;
  }
  if (platform === "linux") {
    return [
      `systemctl --user disable --now ${LEGACY_SYSTEMD_UNIT}`,
      `rm -f ${quotePosixShell(definitionFile)}`,
      "systemctl --user daemon-reload",
    ].join("; ");
  }
  return [
    `schtasks.exe /Delete /TN "${legacyWindowsTaskTarget()}" /F`,
    `Remove-Item -LiteralPath ${quotePowerShell(definitionFile)} -ErrorAction SilentlyContinue`,
  ].join("; ");
}
