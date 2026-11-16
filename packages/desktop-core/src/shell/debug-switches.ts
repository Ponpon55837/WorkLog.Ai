/** Chromium and Node switches that open a debugging channel into the main process; a packaged App refuses all of them. */
export const FORBIDDEN_DEBUG_SWITCHES: readonly string[] = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "inspect",
  "inspect-brk",
];

/** The first forbidden switch the process was started with, or undefined. `hasSwitch` is `app.commandLine.hasSwitch`. */
export function findForbiddenDebugSwitch(hasSwitch: (name: string) => boolean): string | undefined {
  return FORBIDDEN_DEBUG_SWITCHES.find((name) => hasSwitch(name));
}
