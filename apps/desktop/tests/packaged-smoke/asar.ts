import { closeSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

export function resourcesPath(executable: string): string {
  return process.platform === "darwin"
    ? join(dirname(dirname(executable)), "Resources")
    : join(dirname(executable), "resources");
}

export function asarPath(executable: string): string {
  return join(resourcesPath(executable), "app.asar");
}

function readBytes(descriptor: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  readSync(descriptor, buffer, 0, length, position);
  return buffer;
}

interface AsarNode {
  files?: Record<string, AsarNode>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
}

// Format: a 16-byte pickle prefix, the JSON header, then the file bytes it points to.
export function* asarFiles(file: string): Generator<[string, Buffer]> {
  const descriptor = openSync(file, "r");
  try {
    const prefix = readBytes(descriptor, 0, 16);
    const headerSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    const header = JSON.parse(readBytes(descriptor, 16, jsonLength).toString("utf8")) as AsarNode;
    const contentStart = 8 + headerSize;
    const stack: Array<[string, AsarNode]> = [["", header]];
    while (stack.length > 0) {
      const [path, node] = stack.pop() as [string, AsarNode];
      for (const [name, child] of Object.entries(node.files ?? {})) {
        if (child.files) stack.push([`${path}/${name}`, child]);
        else if (!child.unpacked && child.offset !== undefined) {
          yield [`${path}/${name}`, readBytes(descriptor, contentStart + Number(child.offset), child.size ?? 0)];
        }
      }
    }
  } finally {
    closeSync(descriptor);
  }
}
