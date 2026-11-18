import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePrivateFile } from "../../packages/desktop-core/src/index.js";

const roots: string[] = [];

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "wi-private-file-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("writePrivateFile", () => {
  it("creates the file with the bytes", async () => {
    const target = join(directory(), "out.json");
    await writePrivateFile(target, Buffer.from("synthetic bytes", "utf8"));
    expect(readFileSync(target, "utf8")).toBe("synthetic bytes");
  });

  it.skipIf(process.platform === "win32")("is owner-only even over an existing 0644 file", async () => {
    const root = directory();
    const target = join(root, "out.json");
    writeFileSync(target, "old content");
    chmodSync(target, 0o644);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    await writePrivateFile(target, Buffer.from("new content", "utf8"));
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("new content");
    expect(readdirSync(root)).toEqual(["out.json"]);
  });

  it("removes its temporary file and leaves a target it could not replace as it was", async () => {
    const root = directory();
    const target = join(root, "taken");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "kept");
    await expect(writePrivateFile(target, Buffer.from("x"))).rejects.toThrow();
    expect(readdirSync(root)).toEqual(["taken"]);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("kept");
  });

  it("fails without leaving anything when the folder is missing", async () => {
    const root = directory();
    await expect(writePrivateFile(join(root, "missing", "out.json"), Buffer.from("x"))).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
});
