import { describe, expect, it } from "vitest";
import { APPLIES_TO_GLOB_STARS_FIX, MAX_APPLIES_TO_GLOB_STARS } from "../../packages/core/src/index.js";
import { recordKnowledgeInputSchema, updateKnowledgeInputSchema } from "../../packages/schema/src/index.js";

// Fictional scopes only.
const BASE = {
  projectRoot: "/tmp/fictional-project",
  idempotencyKey: "applies-to-schema",
  kind: "gotcha",
  title: "Fictional rule",
  body: "A synthetic rule.",
} as const;

describe("appliesTo write-time star bound", () => {
  it("accepts plain paths, ordinary globs, and globs at the bound", () => {
    const appliesTo = [
      "src/a.ts",
      "packages/*/src/**/*-service.ts",
      `src/${"*".repeat(40)}.ts`, // adjacent stars fold into one
      "*a".repeat(MAX_APPLIES_TO_GLOB_STARS),
    ];
    expect(recordKnowledgeInputSchema.safeParse({ ...BASE, appliesTo }).success).toBe(true);
  });

  it("rejects a new glob above the bound with a message that says how to fix it", () => {
    const result = recordKnowledgeInputSchema.safeParse({
      ...BASE,
      appliesTo: ["src/a.ts", "*a".repeat(MAX_APPLIES_TO_GLOB_STARS + 1)],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["appliesTo", 1],
        message: `This appliesTo glob has too many wildcards. ${APPLIES_TO_GLOB_STARS_FIX}`,
      }),
    ]);
    expect(APPLIES_TO_GLOB_STARS_FIX).toContain("split it into narrower globs or list plain paths");
  });

  it("lets an update keep a stored entry above the bound, so other fields stay editable", () => {
    const overComplex = "*a".repeat(MAX_APPLIES_TO_GLOB_STARS + 1);
    for (const input of [
      { status: "archived" },
      { title: "Renamed fictional rule", appliesTo: ["src/a.ts", overComplex] },
    ])
      expect(
        updateKnowledgeInputSchema.safeParse({ projectRoot: BASE.projectRoot, knowledgeId: "k-1", ...input }).success,
      ).toBe(true);
  });
});
