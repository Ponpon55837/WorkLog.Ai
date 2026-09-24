import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_INPUT_PAYLOAD_BYTES, parseMcpInput } from "../../apps/mcp/src/input.js";

describe("MCP input boundary", () => {
  const schema = z.object({ payload: z.string() });

  it("accepts valid bounded input", () => {
    expect(parseMcpInput(schema, { payload: "small" })).toMatchObject({
      success: true,
      data: { payload: "small" },
    });
  });

  it("rejects an oversized serialized payload before schema processing", () => {
    const result = parseMcpInput(schema, { payload: "x".repeat(MAX_INPUT_PAYLOAD_BYTES) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("must not exceed");
    }
  });

  it("rejects non-serializable input", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const result = parseMcpInput(schema, cyclic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("JSON serializable");
    }
  });
});
