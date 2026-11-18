import { describe, expect, it } from "vitest";
import {
  ALLOWED_AUDIT_IGNORES,
  auditIgnoreProblems,
  compareVersions,
  lockfileVersions,
  parseIgnoreGhsas,
  readWorkspaceFiles,
  withoutAuditConfig,
} from "../../../scripts/check-audit-ignores.mjs";

const { workspaceYaml: WORKSPACE, lockfileText: LOCKFILE } = readWorkspaceFiles();
const PICOMATCH_LOCK = "packages:\n\n  picomatch@4.0.7:\n    resolution: {}\n";

describe("pnpm audit exceptions", () => {
  it("allows exactly one exception, GHSA-fc5q-39xc-vjpf for picomatch <= 4.0.7", () => {
    expect(ALLOWED_AUDIT_IGNORES).toEqual({
      "GHSA-fc5q-39xc-vjpf": { package: "picomatch", vulnerableUpTo: "4.0.7" },
    });
  });

  it("pnpm-workspace.yaml ignores exactly the allowed advisories, and each still applies to the lockfile", () => {
    const ignored = parseIgnoreGhsas(WORKSPACE);
    expect(ignored).toEqual(["GHSA-fc5q-39xc-vjpf"]);
    expect(auditIgnoreProblems({ ignored, lockfileText: LOCKFILE, reportedGhsas: null })).toEqual([]);
  });

  it("fails on an ignored advisory that is not allowed", () => {
    const problems = auditIgnoreProblems({
      ignored: ["GHSA-fc5q-39xc-vjpf", "GHSA-aaaa-bbbb-cccc"],
      lockfileText: PICOMATCH_LOCK,
      reportedGhsas: null,
    });
    expect(problems).toEqual([expect.stringContaining("GHSA-aaaa-bbbb-cccc is ignored")]);
  });

  it("fails when an allowed advisory is no longer ignored", () => {
    const problems = auditIgnoreProblems({ ignored: [], lockfileText: PICOMATCH_LOCK, reportedGhsas: null });
    expect(problems).toEqual([expect.stringContaining("no longer ignored")]);
  });

  it("fails when pnpm audit no longer reports the ignored advisory", () => {
    const problems = auditIgnoreProblems({
      ignored: ["GHSA-fc5q-39xc-vjpf"],
      lockfileText: PICOMATCH_LOCK,
      reportedGhsas: ["GHSA-other-0000-0000"],
    });
    expect(problems).toEqual([expect.stringContaining("no longer reports it")]);
  });

  it("fails when only a patched picomatch is installed", () => {
    const problems = auditIgnoreProblems({
      ignored: ["GHSA-fc5q-39xc-vjpf"],
      lockfileText: "packages:\n\n  picomatch@4.0.8:\n    resolution: {}\n",
      reportedGhsas: ["GHSA-fc5q-39xc-vjpf"],
    });
    expect(problems).toEqual([expect.stringContaining("no vulnerable picomatch")]);
  });

  it("passes while a vulnerable version is installed and still reported", () => {
    expect(
      auditIgnoreProblems({
        ignored: ["GHSA-fc5q-39xc-vjpf"],
        lockfileText: PICOMATCH_LOCK,
        reportedGhsas: ["GHSA-fc5q-39xc-vjpf"],
      }),
    ).toEqual([]);
  });

  it("parses the ignore list and strips the auditConfig block", () => {
    const yaml = [
      "packages:",
      "  - apps/*",
      "auditConfig:",
      "  ignoreGhsas:",
      "    # reason",
      "    - GHSA-fc5q-39xc-vjpf",
      "    - 'GHSA-aaaa-bbbb-cccc' # other",
      "allowBuilds:",
      "  esbuild: true",
    ].join("\n");
    expect(parseIgnoreGhsas(yaml)).toEqual(["GHSA-fc5q-39xc-vjpf", "GHSA-aaaa-bbbb-cccc"]);
    expect(withoutAuditConfig(yaml)).toBe("packages:\n  - apps/*\nallowBuilds:\n  esbuild: true");
    expect(() => parseIgnoreGhsas("auditConfig:\n  ignoreGhsas:\n    - not-an-id\n")).toThrow(/Unrecognised/);
  });

  it("reads lockfile versions and compares versions", () => {
    expect(
      lockfileVersions("  picomatch@2.3.1:\n  picomatch@4.0.7(x@1.0.0):\n  picomatchx@9.0.0:\n", "picomatch"),
    ).toEqual(["2.3.1", "4.0.7"]);
    expect(compareVersions("4.0.7", "4.0.8")).toBe(-1);
    expect(compareVersions("4.0.8", "4.0.7")).toBe(1);
    expect(compareVersions("4.0.7", "4.0.7")).toBe(0);
    expect(compareVersions("4.0.8-beta.1", "4.0.8")).toBe(-1);
  });
});
