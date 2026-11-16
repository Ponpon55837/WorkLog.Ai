import { createServer } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

/** Whether a TCP listener can be bound on `127.0.0.1:port` right now, and the errno code when it cannot. */
export type LoopbackPortProbe = { free: true } | { free: false; code: string };

/**
 * Binds and immediately releases `127.0.0.1:port`. This is only a hint (another process may take the port a moment
 * later); the real `listen` stays the authority. It is the same address family the API listens on, so a port held on
 * `127.0.0.1` shows up, while one held on another interface does not.
 */
export function probeLoopbackPort(port: number): Promise<LoopbackPortProbe> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => resolve({ free: false, code: error.code ?? "UNKNOWN" }));
    probe.listen(port, LOOPBACK_HOST, () => {
      probe.close(() => resolve({ free: true }));
    });
  });
}
