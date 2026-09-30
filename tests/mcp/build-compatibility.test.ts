import { describe, expect, it } from "vitest";
import { computeMcpCompatibility } from "../../apps/mcp/src/build-compatibility.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/index.js";

/** Build-only snapshots connect without opening a store, database, or lease registry. */
describe("MCP build compatibility", () => {
  it("uses a stable digest of the actual tools, full contracts, and instructions", async () => {
    const first = await computeMcpCompatibility();
    const second = await computeMcpCompatibility();
    expect(first).toEqual(second);
    expect(first.compatibilityId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
  });

  it("requires a new compatibility identity after a schema upgrade without any tool changes", async () => {
    const current = await computeMcpCompatibility();
    const upgraded = await computeMcpCompatibility(LATEST_SCHEMA_VERSION + 1);
    expect(upgraded.compatibilityId).not.toBe(current.compatibilityId);
  });
});
