import { createServer } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

export type LoopbackPortProbe = { free: true } | { free: false; code: string };

/** Only a hint: another process may take the port later, so the real `listen` stays the authority. */
export function probeLoopbackPort(port: number): Promise<LoopbackPortProbe> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => resolve({ free: false, code: error.code ?? "UNKNOWN" }));
    probe.listen(port, LOOPBACK_HOST, () => {
      probe.close(() => resolve({ free: true }));
    });
  });
}
