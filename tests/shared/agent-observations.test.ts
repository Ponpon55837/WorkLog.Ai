import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyHostObservation,
  hostForClientName,
  readCurrentContractFingerprint,
  readHostObservations,
} from "../../packages/shared/src/agent-observations.js";

// Synthetic files only.
const A = "a".repeat(64);
const B = "b".repeat(64);
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shared-observations-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeObservations(content: unknown): void {
  writeFileSync(join(root, "agent-observations.json"), typeof content === "string" ? content : JSON.stringify(content));
}

function writeRuntime(pointer: string, fingerprintFile: string | undefined, id = "runtime-1"): void {
  writeFileSync(join(root, "current"), pointer);
  if (fingerprintFile === undefined) return;
  const dist = join(root, "runtimes", id, "app", "libexec", "apps", "mcp", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "contract-fingerprint.json"), fingerprintFile);
}

describe("hostForClientName", () => {
  it("maps the known client names, ignoring case and spaces, and nothing else", () => {
    expect(hostForClientName("claude-code")).toBe("claude-code");
    expect(hostForClientName(" Codex-MCP-Client ")).toBe("codex");
    expect(hostForClientName("claude-ai")).toBe("claude-desktop");
    expect(hostForClientName("some-other-client")).toBeUndefined();
  });
});

describe("readHostObservations", () => {
  it("reads one observation per host and keeps the newest of two names for the same host", () => {
    writeObservations({
      observations: {
        codex: { contractFingerprint: A, observedAt: "2026-11-19T01:00:00.000Z" },
        "codex-mcp-client": { contractFingerprint: B, observedAt: "2026-11-19T02:00:00.000Z" },
        "claude-code": { contractFingerprint: A, observedAt: "2026-11-19T00:00:00.000Z" },
      },
    });
    expect(readHostObservations(root)).toEqual({
      codex: { contractFingerprint: B, observedAt: "2026-11-19T02:00:00.000Z" },
      "claude-code": { contractFingerprint: A, observedAt: "2026-11-19T00:00:00.000Z" },
    });
  });

  it("sorts an entry without a time before one with a time", () => {
    writeObservations({
      observations: {
        codex: { contractFingerprint: A },
        "codex-mcp-client": { contractFingerprint: B, observedAt: "2026-11-19T02:00:00.000Z" },
      },
    });
    expect(readHostObservations(root).codex?.contractFingerprint).toBe(B);
  });

  it("treats a missing, malformed, oversized or wrongly shaped file as no observation", () => {
    expect(readHostObservations(root)).toEqual({});
    writeObservations("{not json");
    expect(readHostObservations(root)).toEqual({});
    writeObservations("[]");
    expect(readHostObservations(root)).toEqual({});
    writeObservations({ observations: null });
    expect(readHostObservations(root)).toEqual({});
    writeObservations({ observations: "x" });
    expect(readHostObservations(root)).toEqual({});
    writeObservations(`{"observations":{},"pad":"${"x".repeat(300 * 1024)}"}`);
    expect(readHostObservations(root)).toEqual({});
  });

  it("ignores unknown clients, non-object values and entries without a valid fingerprint", () => {
    writeObservations({
      observations: {
        unknown: { contractFingerprint: A },
        codex: null,
        "claude-code": { contractFingerprint: "short" },
        "claude-ai": { contractFingerprint: 7 },
      },
    });
    expect(readHostObservations(root)).toEqual({});
  });
});

describe("readCurrentContractFingerprint", () => {
  it("follows the current pointer to the runtime's fingerprint file", () => {
    writeRuntime("runtime-1\n", JSON.stringify({ contractFingerprint: A }));
    expect(readCurrentContractFingerprint(root)).toBe(A);
  });

  it("accepts a pointer with a Windows line ending", () => {
    writeRuntime("runtime-1\r\n", JSON.stringify({ contractFingerprint: A }));
    expect(readCurrentContractFingerprint(root)).toBe(A);
  });

  it("is undefined when the pointer, the file or the fingerprint is missing or malformed", () => {
    expect(readCurrentContractFingerprint(root)).toBeUndefined();
    writeRuntime("runtime-1\n", undefined);
    expect(readCurrentContractFingerprint(root)).toBeUndefined();
    writeRuntime("../escape\n", JSON.stringify({ contractFingerprint: A }));
    expect(readCurrentContractFingerprint(root)).toBeUndefined();
    writeRuntime("two\nlines\n", JSON.stringify({ contractFingerprint: A }));
    expect(readCurrentContractFingerprint(root)).toBeUndefined();
    writeRuntime("runtime-1\n", JSON.stringify({ contractFingerprint: "nope" }));
    expect(readCurrentContractFingerprint(root)).toBeUndefined();
    writeRuntime("runtime-1\n", "not json");
    expect(readCurrentContractFingerprint(root)).toBeUndefined();
  });
});

describe("classifyHostObservation", () => {
  it("is current only when the host saw the installed contract", () => {
    expect(classifyHostObservation({ contractFingerprint: A }, A)).toBe("current");
    expect(classifyHostObservation({ contractFingerprint: A }, B)).toBe("stale");
    expect(classifyHostObservation({ contractFingerprint: A }, undefined)).toBe("stale");
    expect(classifyHostObservation(undefined, A)).toBe("none");
  });
});
