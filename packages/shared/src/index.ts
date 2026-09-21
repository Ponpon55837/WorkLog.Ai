export const APP_NAME = "Work Intelligence";
export const API_PREFIX = "/api";
export const DEFAULT_SERVER_PORT = 3210;
export const DEFAULT_WEB_PORT = 5966;

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncateText(value: string, maxLength = 240): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
