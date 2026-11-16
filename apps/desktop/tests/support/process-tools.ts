import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

/** Small process and port helpers shared by the unpackaged and the packaged smoke tests (no Electron import). */

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

export async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = net.createServer();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveFree(true)));
  });
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The profile variables the App may read, each pointing at a folder inside the isolated home. */
export function profileDirectories(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
}

/**
 * The proportional set size of a Linux process in bytes: its private pages plus its share of every shared page, so the
 * values of several processes add up to the real footprint (a plain RSS counts shared Chromium pages once per process).
 * Undefined on other systems and when `/proc/<pid>/smaps_rollup` cannot be read (the process ended, or the kernel is old).
 */
export function readPssBytes(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const match = /^Pss:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}
