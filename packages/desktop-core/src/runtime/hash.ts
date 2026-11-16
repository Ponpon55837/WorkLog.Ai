import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** What one streamed read of a file produced. */
export interface FileDigest {
  readonly sha256: string;
  readonly bytes: number;
}

const READ_CHUNK_BYTES = 1024 * 1024;

/** SHA-256 of a file read as a stream, so a 100 MB executable never sits in memory. */
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
