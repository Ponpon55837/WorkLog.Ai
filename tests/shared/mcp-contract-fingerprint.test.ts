import { describe, expect, it } from "vitest";
import { mcpContractFingerprint } from "../../packages/shared/src/mcp-contract-fingerprint.js";

const search = {
  name: "work_search",
  description: "Search records.",
  inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
  annotations: { readOnlyHint: true },
};
const finalize = {
  name: "work_finalize",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
};

describe("mcpContractFingerprint", () => {
  it("is a 64-character hex digest", () => {
    expect(mcpContractFingerprint([search])).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores tool order, object key order, descriptions and undefined members", () => {
    const reordered = {
      annotations: { readOnlyHint: true },
      inputSchema: { properties: { limit: { type: "number" }, query: { type: "string" } }, type: "object" },
      name: "work_search",
      description: "Different prose.",
      title: "Search",
      outputSchema: undefined,
    };
    expect(mcpContractFingerprint([finalize, reordered])).toBe(mcpContractFingerprint([search, finalize]));
  });

  it("changes when a name, schema, output schema or annotation changes", () => {
    const base = mcpContractFingerprint([search, finalize]);
    const changed = [
      [{ ...search, name: "work_find" }, finalize],
      [{ ...search, inputSchema: { type: "object", properties: { query: { type: "number" } } } }, finalize],
      [{ ...search, outputSchema: { type: "object" } }, finalize],
      [{ ...search, annotations: { readOnlyHint: false } }, finalize],
      [search],
    ].map((tools) => mcpContractFingerprint(tools));
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
  });

  it("keeps arrays ordered, because order inside a schema is part of the contract", () => {
    const enumOf = (values: string[]) => ({ name: "t", inputSchema: { enum: values } });
    expect(mcpContractFingerprint([enumOf(["a", "b"])])).not.toBe(mcpContractFingerprint([enumOf(["b", "a"])]));
  });

  it("fingerprints an empty list", () => {
    expect(mcpContractFingerprint([])).toMatch(/^[a-f0-9]{64}$/);
  });
});
