export const DEFAULT_SERVER_PORT = 3210;

export function resolveServerPort(environment: NodeJS.ProcessEnv = process.env): number {
  const port = Number(environment.WORK_INTELLIGENCE_PORT ?? DEFAULT_SERVER_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SERVER_PORT;
}
