import { describe, expect, it } from "vitest";
import {
  decodeFileHistoryCursor,
  encodeFileHistoryCursor,
  fileHistoryQuerySchema,
  isRepositoryRelativePath,
} from "../../packages/schema/src/index.js";

// Fictional values only.
const root = "/fictional/lighthouse";

describe("file history query", () => {
  it("accepts repository-relative paths with either separator", () => {
    for (const path of ["src/lamp/beam.ts", "./src/lamp/beam.ts", "src\\lamp\\beam.ts", "README.md", "a..b/c.ts"]) {
      expect(isRepositoryRelativePath(path), path).toBe(true);
    }
  });

  it("rejects absolute, home, drive, UNC, traversal, and control-character paths", () => {
    for (const path of [
      "/etc/hosts",
      "\\\\server\\share\\a.ts",
      "C:\\temp\\a.ts",
      "c:a.ts",
      "~/a.ts",
      "../a.ts",
      "src/../../a.ts",
      "src\\..\\a.ts",
      "src/\u0000a.ts",
    ]) {
      expect(isRepositoryRelativePath(path), JSON.stringify(path)).toBe(false);
    }
  });

  it("bounds the path count and length, rejects unknown keys, and pages one path only", () => {
    const cursor = encodeFileHistoryCursor({ completedAt: "2026-01-02T03:04:05.000Z", id: "session-①" });
    expect(fileHistoryQuerySchema.safeParse({ projectRoot: root, paths: ["a.ts"], cursor }).success).toBe(true);
    expect(fileHistoryQuerySchema.safeParse({ projectRoot: root, paths: ["a.ts", "b.ts"], cursor }).success).toBe(
      false,
    );
    expect(fileHistoryQuerySchema.safeParse({ projectRoot: root, paths: [] }).success).toBe(false);
    expect(fileHistoryQuerySchema.safeParse({ projectRoot: root, paths: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(fileHistoryQuerySchema.safeParse({ projectRoot: root, paths: ["a".repeat(501)] }).success).toBe(false);
    expect(fileHistoryQuerySchema.safeParse({ projectRoot: root, paths: ["a.ts"], limit: 11 }).success).toBe(false);
    expect(fileHistoryQuerySchema.safeParse({ projectRoot: root, paths: ["a.ts"], depth: 1 }).success).toBe(false);
  });

  it("round-trips its own cursor and refuses anything else", () => {
    const position = { completedAt: "2026-01-02T03:04:05.000Z", id: "session-①" };
    expect(decodeFileHistoryCursor(encodeFileHistoryCursor(position))).toEqual(position);
    for (const forged of ["not a cursor", "e30", "WyJhIl0", "!!"]) {
      expect(decodeFileHistoryCursor(forged), forged).toBeUndefined();
    }
  });
});
