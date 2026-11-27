const NOT_PERMITTED_BIND_CODES: ReadonlySet<string> = new Set(["EACCES", "EADDRNOTAVAIL"]);

export type PortFailureCode = "PORT_NOT_PERMITTED" | "PORT_OCCUPIED_BY_OTHER";

export function portFailureCode(errno: string): PortFailureCode {
  return NOT_PERMITTED_BIND_CODES.has(errno) ? "PORT_NOT_PERMITTED" : "PORT_OCCUPIED_BY_OTHER";
}
