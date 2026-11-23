import { describe, expect, it } from "vitest";
import { usageScanRequestSchema } from "../../packages/schema/src/index.js";

describe("usageScanRequestSchema", () => {
  it("accepts a bounded request", () => {
    const parsed = usageScanRequestSchema.safeParse({
      projectIds: ["p1"],
      manualFolders: ["/tmp/example"],
      range: "30d",
      since: "2026-11-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown keys, bad ranges and oversized lists", () => {
    expect(usageScanRequestSchema.safeParse({ range: "7d", extra: 1 }).success).toBe(false);
    expect(usageScanRequestSchema.safeParse({ range: "1y" }).success).toBe(false);
    expect(usageScanRequestSchema.safeParse({ range: "7d", manualFolders: Array(21).fill("/a") }).success).toBe(false);
    expect(usageScanRequestSchema.safeParse({ range: "7d", manualFolders: ["/" + "a".repeat(1024)] }).success).toBe(
      false,
    );
    expect(usageScanRequestSchema.safeParse({ range: "7d", projectIds: Array(201).fill("p") }).success).toBe(false);
  });
});
