/** errno codes of a bind that the operating system refused for this user (not "someone else holds it"). */
const NOT_PERMITTED_BIND_CODES: ReadonlySet<string> = new Set(["EACCES", "EADDRNOTAVAIL"]);

/** The backend error a failed bind means. */
export type PortFailureCode = "PORT_NOT_PERMITTED" | "PORT_OCCUPIED_BY_OTHER";

/**
 * Which backend error a failed bind means: a port the OS does not let this user use (EACCES, EADDRNOTAVAIL: for example
 * a Windows excluded range), or one another program holds. The single source for the server, the App and the supervisor.
 */
export function portFailureCode(errno: string): PortFailureCode {
  return NOT_PERMITTED_BIND_CODES.has(errno) ? "PORT_NOT_PERMITTED" : "PORT_OCCUPIED_BY_OTHER";
}
