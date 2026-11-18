import { describe, expect, it } from "vitest";
import {
  ALLOWED_AUDIT_IGNORES,
  auditIgnoreProblems,
  compareVersions,
  lockfileVersions,
  parseIgnoreGhsas,
  readWorkspaceFiles,
  registryProblems,
  REMOVAL_STEPS,
  withoutAuditConfig,
} from "../../../scripts/check-audit-ignores.mjs";

const { workspaceYaml: WORKSPACE, lockfileText: LOCKFILE } = readWorkspaceFiles();
const PICOMATCH_LOCK = "packages:\n\n  picomatch@4.0.7:\n    resolution: {}\n";
// A synthetic allowed list, so the logic stays tested while the real list is empty.
const ALLOWED = { "GHSA-fc5q-39xc-vjpf": { package: "picomatch", vulnerableUpTo: "4.0.7" } };

describe("pnpm audit exceptions", () => {
  it("allows no exceptions (GHSA-fc5q-39xc-vjpf was resolved in 1.6.53 by dropping the dependency path)", () => {
    expect(ALLOWED_AUDIT_IGNORES).toEqual({});
  });

  it("pnpm-workspace.yaml ignores no advisories, matching the allowed list", () => {
    const ignored = parseIgnoreGhsas(WORKSPACE);
    expect(ignored).toEqual([]);
    expect(auditIgnoreProblems({ ignored, lockfileText: LOCKFILE, reportedGhsas: null })).toEqual([]);
    expect(registryProblems({ ignored, registryVersions: {} })).toEqual([]);
  });

  it("rejects an ignore that the real allowed list does not contain", () => {
    expect(
      auditIgnoreProblems({ ignored: ["GHSA-fc5q-39xc-vjpf"], lockfileText: PICOMATCH_LOCK, reportedGhsas: null }),
    ).toEqual([expect.stringContaining("GHSA-fc5q-39xc-vjpf is ignored")]);
  });

  it("fails on an ignored advisory that is not allowed", () => {
    const problems = auditIgnoreProblems({
      ignored: ["GHSA-fc5q-39xc-vjpf", "GHSA-aaaa-bbbb-cccc"],
      lockfileText: PICOMATCH_LOCK,
      reportedGhsas: null,
      allowed: ALLOWED,
    });
    expect(problems).toEqual([expect.stringContaining("GHSA-aaaa-bbbb-cccc is ignored")]);
  });

  it("fails when an allowed advisory is no longer ignored", () => {
    const problems = auditIgnoreProblems({
      ignored: [],
      lockfileText: PICOMATCH_LOCK,
      reportedGhsas: null,
      allowed: ALLOWED,
    });
    expect(problems).toEqual([expect.stringContaining("no longer ignored")]);
  });

  it("fails when pnpm audit no longer reports the ignored advisory", () => {
    const problems = auditIgnoreProblems({
      ignored: ["GHSA-fc5q-39xc-vjpf"],
      lockfileText: PICOMATCH_LOCK,
      reportedGhsas: ["GHSA-other-0000-0000"],
      allowed: ALLOWED,
    });
    expect(problems).toEqual([expect.stringContaining("no longer reports it")]);
  });

  it("fails when only a patched picomatch is installed", () => {
    const problems = auditIgnoreProblems({
      ignored: ["GHSA-fc5q-39xc-vjpf"],
      lockfileText: "packages:\n\n  picomatch@4.0.8:\n    resolution: {}\n",
      reportedGhsas: ["GHSA-fc5q-39xc-vjpf"],
      allowed: ALLOWED,
    });
    expect(problems).toEqual([expect.stringContaining("no vulnerable picomatch")]);
  });

  it("passes while a vulnerable version is installed and still reported", () => {
    expect(
      auditIgnoreProblems({
        ignored: ["GHSA-fc5q-39xc-vjpf"],
        lockfileText: PICOMATCH_LOCK,
        reportedGhsas: ["GHSA-fc5q-39xc-vjpf"],
        allowed: ALLOWED,
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

  describe("registry watch (--registry)", () => {
    const ignored = ["GHSA-fc5q-39xc-vjpf"];

    it("passes while the registry publishes nothing above the vulnerable range", () => {
      expect(
        registryProblems({ ignored, allowed: ALLOWED, registryVersions: { picomatch: ["2.3.1", "4.0.6", "4.0.7"] } }),
      ).toEqual([]);
    });

    it("ignores pre-releases above the range (not a patched release)", () => {
      expect(
        registryProblems({
          ignored,
          allowed: ALLOWED,
          registryVersions: { picomatch: ["4.0.7", "4.0.8-beta.1", "5.0.0-rc.0"] },
        }),
      ).toEqual([]);
    });

    it("fails when a patched stable release is published, naming the newest one and the removal steps", () => {
      const problems = registryProblems({
        ignored,
        allowed: ALLOWED,
        registryVersions: { picomatch: ["4.0.7", "4.0.8", "4.1.0", "4.0.9"] },
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("picomatch 4.1.0 is published");
      expect(problems[0]).toContain("pnpm update --recursive picomatch");
      expect(problems[0]).toContain("docs/security/audit-exceptions.md");
      expect(problems[0]).toContain("ALLOWED_AUDIT_IGNORES");
    });

    it("fails when the registry lookup failed, so the watch never passes silently", () => {
      expect(registryProblems({ ignored, allowed: ALLOWED, registryVersions: {} })).toEqual([
        expect.stringContaining("could not read the published versions of picomatch"),
      ]);
    });

    it("only checks advisories that are both ignored and allowed", () => {
      expect(registryProblems({ ignored: [], allowed: ALLOWED, registryVersions: { picomatch: ["9.9.9"] } })).toEqual(
        [],
      );
      expect(registryProblems({ ignored: ["GHSA-aaaa-bbbb-cccc"], allowed: ALLOWED, registryVersions: {} })).toEqual(
        [],
      );
    });

    it("the audit-no-longer-reported failure carries the same removal steps", () => {
      const problems = auditIgnoreProblems({
        ignored,
        lockfileText: PICOMATCH_LOCK,
        reportedGhsas: [],
        allowed: ALLOWED,
      });
      expect(problems).toEqual([expect.stringContaining(REMOVAL_STEPS.replaceAll("<package>", "picomatch"))]);
    });
  });
});
