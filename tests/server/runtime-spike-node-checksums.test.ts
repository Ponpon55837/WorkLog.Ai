import { describe, expect, it } from "vitest";
import { DEFAULT_NODE_VERSION } from "../../scripts/desktop-runtime-spike/common.mjs";
import { PINNED_NODE_SHA256, pinnedNodeSha256 } from "../../scripts/desktop-runtime-spike/node-checksums.mjs";

describe("pinned Node.js archive hashes", () => {
  it("cover every platform the runtime is built for, for the default Node.js version", () => {
    for (const archive of ["win-x64.zip", "darwin-arm64.tar.gz", "darwin-x64.tar.gz", "linux-x64.tar.gz"]) {
      expect(pinnedNodeSha256(DEFAULT_NODE_VERSION, `node-${DEFAULT_NODE_VERSION}-${archive}`)).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }
  });

  it("only name archives of their own version, each with a distinct SHA-256", () => {
    for (const [version, archives] of Object.entries(PINNED_NODE_SHA256)) {
      for (const [name, hash] of Object.entries(archives)) {
        expect(name.startsWith(`node-${version}-`)).toBe(true);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(new Set(Object.values(archives)).size).toBe(Object.keys(archives).length);
    }
  });

  it("know nothing about a version or an archive that is not pinned", () => {
    expect(pinnedNodeSha256("v0.0.0", "node-v0.0.0-linux-x64.tar.gz")).toBeUndefined();
    expect(pinnedNodeSha256(DEFAULT_NODE_VERSION, "node-other.tar.gz")).toBeUndefined();
  });
});
