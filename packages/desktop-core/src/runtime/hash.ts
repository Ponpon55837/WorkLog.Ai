import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export interface FileDigest {
  readonly sha256: string;
  readonly bytes: number;
}

const READ_CHUNK_BYTES = 1024 * 1024;

export async function hashFile(filePath: string): Promise<FileDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES })) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}
