export const FORBIDDEN_DEBUG_SWITCHES: readonly string[] = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "inspect",
  "inspect-brk",
];

export function findForbiddenDebugSwitch(hasSwitch: (name: string) => boolean): string | undefined {
  return FORBIDDEN_DEBUG_SWITCHES.find((name) => hasSwitch(name));
}
