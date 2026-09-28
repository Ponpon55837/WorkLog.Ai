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

  it("rejects unknown keys at the top level and inside nested objects, arrays, and effects", () => {
    const nested = z
      .object({ items: z.array(z.object({ id: z.string() })), meta: z.object({ tag: z.string() }).optional() })
      .superRefine(() => undefined);
    const result = parseMcpInput(nested, {
      items: [{ id: "a" }, { id: "b", extra: 1 }],
      meta: { tag: "x", typo: 2 },
      top: 3,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => [issue.code, issue.path.join("."), issue.message])).toEqual([
        ["unrecognized_keys", "", expect.stringContaining("Unknown argument(s): top")],
        ["unrecognized_keys", "items.1", expect.stringContaining("in items.1: extra")],
        ["unrecognized_keys", "meta", expect.stringContaining("in meta: typo")],
      ]);
    }
  });

  it("allows keys that the schema explicitly accepts: passthrough objects, catchall, and record values", () => {
    const open = z.object({
      loose: z.object({ a: z.string() }).passthrough(),
      extra: z.object({ a: z.string() }).catchall(z.number()),
      details: z.record(z.unknown()),
    });
    expect(
      parseMcpInput(open, { loose: { a: "x", b: 1 }, extra: { a: "x", b: 2 }, details: { anything: { deep: true } } })
        .success,
    ).toBe(true);
  });

  it("checks union members only when they can hold the value's shape", () => {
    const decisions = z.array(z.union([z.string(), z.object({ text: z.string() })]));
    expect(parseMcpInput(decisions, ["plain", { text: "ok" }]).success).toBe(true);
    const rejected = parseMcpInput(decisions, [{ text: "ok", why: "extra" }]);
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.issues[0]?.message).toContain("in 0: why");

    const either = z.union([z.object({ a: z.string() }), z.object({ a: z.string(), b: z.string() })]);
    expect(parseMcpInput(either, { a: "x", b: "y" }).success).toBe(true);
  });
});
