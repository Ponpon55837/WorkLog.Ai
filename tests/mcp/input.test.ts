import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  finalizeSessionInputSchema,
  flattenInputError,
  updateSessionWorkSummaryInputSchema,
} from "@work-intelligence/schema";
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
      details: z.record(z.string(), z.unknown()),
    });
    expect(
      parseMcpInput(open, {
        loose: { a: "x", b: { arbitrary: { deep: true } } },
        extra: { a: "x", b: 2 },
        details: { anything: { deep: true } },
      }).success,
    ).toBe(true);
  });

  it("allows catchall keys but checks nested catchall values and record value objects", () => {
    const catchallValues = z.object({ fixed: z.string() }).catchall(z.object({ id: z.string() }));
    expect(parseMcpInput(catchallValues, { fixed: "ok", custom: { id: "one" } }).success).toBe(true);

    const invalidCatchall = parseMcpInput(catchallValues, {
      fixed: "ok",
      custom: { id: "one", typo: true },
    });
    expect(invalidCatchall.success).toBe(false);
    if (!invalidCatchall.success) {
      expect(invalidCatchall.error.issues[0]?.path).toEqual(["custom"]);
      expect(invalidCatchall.error.issues[0]?.message).toContain("in custom: typo");
    }

    const recordValues = z.record(z.string(), z.object({ id: z.string() }));
    expect(parseMcpInput(recordValues, { arbitraryKey: { id: "one" } }).success).toBe(true);
    const invalidRecord = parseMcpInput(recordValues, { arbitraryKey: { id: "one", typo: true } });
    expect(invalidRecord.success).toBe(false);
    if (!invalidRecord.success) expect(invalidRecord.error.issues[0]?.message).toContain("in arbitraryKey: typo");
  });

  it("checks the union branch Zod selects so an earlier object cannot silently strip a key", () => {
    const decisions = z.array(z.union([z.string(), z.object({ text: z.string() })]));
    expect(parseMcpInput(decisions, ["plain", { text: "ok" }]).success).toBe(true);
    const rejected = parseMcpInput(decisions, [{ text: "ok", why: "extra" }]);
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.issues[0]?.message).toContain("in 0: why");

    const shorterBranchFirst = z.union([z.object({ a: z.string() }), z.object({ a: z.string(), b: z.string() })]);
    const strippedByFirstBranch = parseMcpInput(shorterBranchFirst, { a: "x", b: "y" });
    expect(strippedByFirstBranch.success).toBe(false);
    if (!strippedByFirstBranch.success) {
      expect(strippedByFirstBranch.error.issues[0]?.message).toContain("Unknown argument(s): b");
    }

    const preservingBranchFirst = z.union([z.object({ a: z.string(), b: z.string() }), z.object({ a: z.string() })]);
    const preservedByFirstBranch = parseMcpInput(preservingBranchFirst, { a: "x", b: "y" });
    expect(preservedByFirstBranch).toMatchObject({ success: true, data: { a: "x", b: "y" } });

    const discriminated = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("one"), one: z.string() }),
      z.object({ kind: z.literal("two"), two: z.string() }),
    ]);
    const wrongDiscriminatorField = parseMcpInput(discriminated, {
      kind: "one",
      one: "selected",
      two: "belongs to another branch",
    });
    expect(wrongDiscriminatorField.success).toBe(false);
    if (!wrongDiscriminatorField.success) {
      expect(wrongDiscriminatorField.error.issues[0]?.message).toContain("Unknown argument(s): two");
    }
  });

  it("checks unknown keys through Zod 4 object wrappers in their input direction", () => {
    const objectSchema = z.object({ name: z.string() });
    const wrappedSchemas: Record<string, z.ZodType> = {
      strict: objectSchema.strict(),
      optional: objectSchema.optional(),
      default: objectSchema.default({ name: "default" }),
      readonly: objectSchema.readonly(),
      lazy: z.lazy(() => objectSchema),
      transform: objectSchema.transform((value) => ({ name: value.name })),
      preprocess: z.preprocess((value) => value, objectSchema),
    };

    for (const [wrapper, wrappedSchema] of Object.entries(wrappedSchemas)) {
      expect(parseMcpInput(wrappedSchema, { name: "valid" }).success, wrapper).toBe(true);
      const rejected = parseMcpInput(wrappedSchema, { name: "valid", typo: true });
      expect(rejected.success, wrapper).toBe(false);
      if (!rejected.success) {
        expect(rejected.error.issues[0]?.code, wrapper).toBe("unrecognized_keys");
        expect(rejected.error.issues[0]?.message, wrapper).toContain("typo");
      }
    }
  });

  it("names the nested key of a field error and leaves top-level and unknown-key messages as they are", () => {
    const nested = z.object({
      title: z.string(),
      workSummary: z.object({ outcomes: z.array(z.string()), scope: z.array(z.string()) }),
    });
    const missing = parseMcpInput(nested, { workSummary: { outcomes: [] } });
    const unknown = parseMcpInput(nested, { title: "t", workSummary: { outcomes: [], scope: [], extra: 1 } });
    expect(missing.success || unknown.success).toBe(false);
    if (missing.success || unknown.success) return;

    const details = flattenInputError(missing.error);
    expect(details.fieldErrors.workSummary).toEqual([expect.stringMatching(/^scope: /)]);
    expect(details.fieldErrors.title?.[0]).not.toMatch(/^title: /);
    expect(flattenInputError(unknown.error).fieldErrors.workSummary?.[0]).toMatch(
      /^Unknown argument\(s\) in workSummary: extra/,
    );
  });

  it("reports the nested cause of a failed union instead of 'Invalid input'", () => {
    const decisionsSchema = z.object({
      workSummary: z.object({
        decisions: z.array(
          z.union([
            z.string(),
            z.strictObject({ text: z.string(), origin: z.enum(["user_requested", "agent_autonomous"]) }),
          ]),
        ),
      }),
    });
    const wrong = parseMcpInput(decisionsSchema, {
      workSummary: { decisions: [{ text: "x", origin: "user_directed" }] },
    });
    const plain = parseMcpInput(decisionsSchema, { workSummary: { decisions: ["plain"] } });
    expect(plain.success).toBe(true);
    expect(wrong.success).toBe(false);
    if (wrong.success) return;

    const message = flattenInputError(wrong.error).fieldErrors.workSummary?.[0] ?? "";
    expect(message).toMatch(/^decisions\.0\.origin: /);
    expect(message).toContain("user_requested");
    expect(message).toContain("agent_autonomous");
    expect(message).not.toBe("decisions.0: Invalid input");
  });

  it("explains a wrong decision origin in a finalize payload", () => {
    const payload = {
      projectRoot: "/p",
      idempotencyKey: "k",
      title: "t",
      summary: "s",
      changedFiles: [],
      verification: { status: "passed" },
      workSummary: {
        outcomes: [],
        scope: [],
        verification: [],
        nextSteps: [],
        decisions: [{ text: "x", origin: "user_directed" }],
      },
    };
    const parsed = parseMcpInput(finalizeSessionInputSchema, payload);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(flattenInputError(parsed.error).fieldErrors.workSummary?.join(" ")).toContain("decisions.0.origin");
  });

  it("reports the branch with fewer issues when union branches fail at the same depth", () => {
    const parsed = parseMcpInput(updateSessionWorkSummaryInputSchema, {
      sessionId: "s",
      idempotencyKey: "k",
      mode: "patch",
      workSummary: { outcomes: ["a"], decisions: [{ text: "x", origin: "bad" }] },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = flattenInputError(parsed.error).fieldErrors.workSummary ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^decisions\.0\.origin: /);
  });
});
