// Union of Chromium `kRestrictedPorts` and Firefox `gBadPortList` within 1024-65535; the unit test pins this set.
export const BROWSER_RESTRICTED_PORTS: readonly number[] = [
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
];

export const MIN_CHANGEABLE_PORT = 1024;
export const MAX_CHANGEABLE_PORT = 65_535;

export type PortProblem = "not-a-number" | "out-of-range" | "below-1024" | "browser-restricted";

export type PortValidation =
  | { readonly kind: "ok"; readonly port: number }
  | { readonly kind: "same"; readonly port: number }
  | { readonly kind: "invalid"; readonly problem: PortProblem };

const DECIMAL = /^\d{1,5}$/;

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
