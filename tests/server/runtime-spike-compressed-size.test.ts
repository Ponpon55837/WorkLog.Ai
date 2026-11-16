import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compressedTarSize, tarStream } from "../../scripts/desktop-runtime-spike/compressed-size.mjs";

const LONG_NAME = `深層/${"長".repeat(40)}/${"x".repeat(80)}.txt`;
const FILES = [
  { path: "launcher.mjs", content: "export {};\n" },
  { path: "node/bin/node", content: "binary".repeat(300) },
  { path: "app/web/中文 檔名 with spaces.html", content: "<p>測試</p>\n" },
  { path: LONG_NAME, content: "" },
  { path: "exact-block.bin", content: "b".repeat(512) },
];

let directory: string;

async function collect(stream: AsyncGenerator<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function listed(): { path: string; size: number }[] {
  return FILES.map((file) => ({ path: file.path, size: Buffer.byteLength(file.content) }));
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "work-intelligence runtime 測試-"));
  for (const file of FILES) {
    const target = path.join(directory, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("runtime spike compressed size", () => {
  it("writes a tar made of whole blocks, ending with two zero blocks", async () => {
    const tar = await collect(tarStream(directory, listed()));
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true);
  });

  it("counts the same bytes as gzip level 6 of the archive, without writing a file", async () => {
    const tar = await collect(tarStream(directory, listed()));
    const size = await compressedTarSize(directory, listed());
    expect(size).toBe(gzipSync(tar, { level: 6 }).length);
    expect(gunzipSync(gzipSync(tar, { level: 6 })).equals(tar)).toBe(true);
    expect(fs.readdirSync(directory).sort()).toEqual(["app", "exact-block.bin", "launcher.mjs", "node", "深層"]);
  });

  it("refuses a file whose length is not the listed size", async () => {
    const wrong = listed().map((file) => (file.path === "launcher.mjs" ? { ...file, size: file.size + 1 } : file));
    await expect(compressedTarSize(directory, wrong)).rejects.toThrow(/launcher\.mjs is 11 bytes/);
  });

  // Windows bsdtar reads arguments in the ANSI code page (the bug this module avoids) and needs a privilege for symlinks.
  it.skipIf(process.platform === "win32" || spawnSync("tar", ["--version"]).status !== 0)(
    "produces an archive the system tar extracts with spaces, non-ASCII and long names intact",
    async () => {
      const archive = path.join(directory, "..", `${path.basename(directory)}.tar`);
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "work-intelligence 解開-"));
      try {
        const symlinks = [{ path: "bin/目前 node", target: "../node/bin/node" }];
        fs.writeFileSync(archive, await collect(tarStream(directory, listed(), symlinks)));
        const extracted = spawnSync("tar", ["-xf", archive, "-C", out], { encoding: "utf8" });
        expect(extracted.status, extracted.stderr).toBe(0);
        for (const file of FILES) {
          expect(fs.readFileSync(path.join(out, ...file.path.split("/")), "utf8")).toBe(file.content);
        }
        expect(fs.readlinkSync(path.join(out, "bin", "目前 node"))).toBe("../node/bin/node");
      } finally {
        fs.rmSync(archive, { force: true });
        fs.rmSync(out, { recursive: true, force: true });
      }
    },
  );
});
