import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { desktopSettingsV1Schema } from "../../packages/desktop-core/src/settings/schema.js";

/**
 * Every leaf of the desktop settings file has at least one non-test reader and one non-test writer, so a field that is
 * saved but never used (or used but never saved) fails here instead of shipping as a dead promise to the user.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");
const PRODUCT_DIRECTORIES = ["packages/desktop-core/src", "apps/desktop/src"];

/** Fields allowed to lack a reader or a writer, each with the reason and the release that closes the gap. */
const NO_READER = new Map<string, string>([
  [
    "active.runtimeVersion",
    "kept for a downgrade to 1.6.57 (its strict schema rejects a file without it); handled in 1.6.58 by keeping it",
  ],
  [
    "active.serviceOwner",
    "kept for a downgrade to 1.6.57 (its strict schema rejects a file without it); handled in 1.6.58 by keeping it",
  ],
  ["lastKnownGood.databaseIdentity", "1.6.59 接上回退"],
  ["lastKnownGood.port", "1.6.59 接上回退"],
  ["lastKnownGood.runtimeVersion", "1.6.59 接上回退"],
]);
const NO_WRITER = new Map<string, string>([
  ["lastKnownGood.databaseIdentity", "1.6.59 接上回退"],
  ["lastKnownGood.port", "1.6.59 接上回退"],
  ["lastKnownGood.runtimeVersion", "1.6.59 接上回退"],
]);

interface ZodNode {
  readonly def: { readonly type: string; readonly shape?: Record<string, ZodNode>; readonly innerType?: ZodNode };
}

function leaves(node: ZodNode, prefix: string): string[] {
  const { def } = node;
  if (def.type === "optional" || def.type === "nullable") return leaves(def.innerType as ZodNode, prefix);
  // The database identity is one shared record: its members are covered by the identity's own tests.
  if (def.type !== "object" || !def.shape || prefix.endsWith("databaseIdentity")) return [prefix];
  return Object.entries(def.shape).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

function productFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name === "dist" ? [] : productFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
  });
}

const sources = PRODUCT_DIRECTORIES.flatMap((directory) => productFiles(path.join(ROOT, directory))).map((file) =>
  readFileSync(file, "utf8"),
);
const allSource = sources.join("\n");

const fields = leaves(desktopSettingsV1Schema as unknown as ZodNode, "");

function readPattern(field: string): RegExp {
  const parts = field.split(".");
  const leaf = parts.at(-1) as string;
  return parts.length === 1
    ? new RegExp(`\\bsettings\\??\\.${leaf}\\b`)
    : new RegExp(`\\b${parts[0]}\\??\\.${leaf}\\b|\\b${parts[0]}\\b[^\\n]*\\{[^}\\n]*\\b${leaf}\\b[^}\\n]*\\}\\s*=`);
}

function writePattern(field: string): RegExp {
  const leaf = field.split(".").at(-1) as string;
  return new RegExp(`\\b${leaf}\\s*[:,]|\\.${leaf}\\s*=[^=]`);
}

describe("desktop settings field usage", () => {
  it("finds the schema leaves", () => {
    expect(fields).toContain("desired.launchAtLogin");
    expect(fields).toContain("installId");
    expect(fields.length).toBeGreaterThan(8);
  });

  for (const field of fields) {
    it(`${field} is read by product code${NO_READER.has(field) ? ` (exempt: ${NO_READER.get(field)})` : ""}`, () => {
      const used = readPattern(field).test(allSource);
      if (NO_READER.has(field)) expect(used).toBe(false);
      else expect(used).toBe(true);
    });

    it(`${field} is written by product code${NO_WRITER.has(field) ? ` (exempt: ${NO_WRITER.get(field)})` : ""}`, () => {
      const used = writePattern(field).test(allSource);
      // The writer pattern is loose (a bare `port:` matches elsewhere), so an exemption only waives the requirement.
      if (!NO_WRITER.has(field)) expect(used).toBe(true);
    });
  }
});
