/**
 * The ports in 1024-65535 that a mainstream browser refuses to open (ERR_UNSAFE_PORT in Chromium, a blocked-port page in
 * Firefox), so a Dashboard on one of them could not be reached from the browser. It is the union of two lists, each
 * restricted to the unprivileged range (ports below 1024 are refused as a whole):
 * - Chromium `net/base/port_util.cc`, `kRestrictedPorts`;
 * - Firefox `netwerk/base/nsIOService.cpp`, `gBadPortList` (the default of `network.security.ports.banned`).
 * Both lists include 4190 (sieve) and 6679 (osaut), so neither is specific to one browser. The browser lists change
 * rarely; the unit test pins this exact set.
 */
export const BROWSER_RESTRICTED_PORTS: readonly number[] = [
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
];

export const MIN_CHANGEABLE_PORT = 1024;
export const MAX_CHANGEABLE_PORT = 65_535;

/** Why an input is refused; the page maps each to a sentence. */
export type PortProblem = "not-a-number" | "out-of-range" | "below-1024" | "browser-restricted";

export type PortValidation =
  | { readonly kind: "ok"; readonly port: number }
  /** The input names the port the backend already serves: nothing to do. */
  | { readonly kind: "same"; readonly port: number }
  | { readonly kind: "invalid"; readonly problem: PortProblem };

const DECIMAL = /^\d{1,5}$/;

/**
 * Checks what the user typed (a decimal integer as a string or number). Pure: whether the port is free is a separate
 * probe, and only a hint.
 */
export function validatePortChange(input: unknown, currentPort: number | null): PortValidation {
  let port: number;
  if (typeof input === "number") {
    if (!Number.isInteger(input)) return { kind: "invalid", problem: "not-a-number" };
    port = input;
  } else if (typeof input === "string") {
    const text = input.trim();
    if (!DECIMAL.test(text)) return { kind: "invalid", problem: "not-a-number" };
    port = Number(text);
  } else {
    return { kind: "invalid", problem: "not-a-number" };
  }
  if (port < 0 || port > MAX_CHANGEABLE_PORT) return { kind: "invalid", problem: "out-of-range" };
  if (port < MIN_CHANGEABLE_PORT) return { kind: "invalid", problem: "below-1024" };
  if (BROWSER_RESTRICTED_PORTS.includes(port)) return { kind: "invalid", problem: "browser-restricted" };
  return port === currentPort ? { kind: "same", port } : { kind: "ok", port };
}
