import { describe, expect, it } from "vitest";
import {
  allowMigrationFor,
  isPositiveRisk,
  needsStorageConsent,
  storageBlocksUse,
  storagePolicy,
  storageRiskFact,
} from "../../packages/desktop-core/src/db-source/storage-policy.js";
import {
  overriddenStorageRisk,
  parseStorageRiskOverride,
} from "../../packages/desktop-core/src/db-source/storage-risk-override.js";
import { applyStartTimeStorageRisk } from "../../packages/desktop-core/src/shell/storage-start-policy.js";
import { buildStorageRiskView } from "../../packages/desktop-core/src/shell/storage-risk-view.js";
import { CandidateRegistry } from "../../packages/desktop-core/src/shell/candidates.js";
import type { StorageRisk } from "../../packages/desktop-core/src/db-source/storage-risk.js";

const POSITIVE: StorageRisk[] = ["removable", "cloud-sync", "hard-link"];

describe("storage policy table", () => {
  it("refuses a network drive and nothing else", () => {
    expect(storagePolicy("network").refused).toBe(true);
    for (const risk of [...POSITIVE, "unknown", "none"] as StorageRisk[])
      expect(storagePolicy(risk).refused).toBe(false);
    expect(storagePolicy(undefined)).toEqual(storagePolicy("none"));
  });

  it("asks for consent on a positive risk, and on unknown only for a source nobody chose", () => {
    for (const risk of POSITIVE) {
      expect(needsStorageConsent(risk, true)).toBe(true);
      expect(isPositiveRisk(risk)).toBe(true);
    }
    expect(needsStorageConsent("unknown", false)).toBe(true);
    expect(needsStorageConsent("unknown", true)).toBe(false);
    expect(needsStorageConsent("none", false)).toBe(false);
    expect(isPositiveRisk("unknown")).toBe(false);
  });

  it("forces the schema update off on a positive risk and never on unknown", () => {
    for (const risk of [...POSITIVE, "network"] as StorageRisk[]) expect(allowMigrationFor(true, risk)).toBe(false);
    expect(allowMigrationFor(true, "unknown")).toBe(true);
    expect(allowMigrationFor(true, "none")).toBe(true);
    expect(allowMigrationFor(false, "none")).toBe(false);
  });

  it("hides use for refused storage or a forbidden update only", () => {
    expect(storageBlocksUse("network", false)).toBe(true);
    expect(storageBlocksUse("removable", true)).toBe(true);
    expect(storageBlocksUse("removable", false)).toBe(false);
    expect(storageBlocksUse("unknown", true)).toBe(false);
  });

  it("reports a fact for every verdict but none", () => {
    expect(storageRiskFact(undefined)).toBeUndefined();
    expect(storageRiskFact({ risk: "none" })).toBeUndefined();
    expect(storageRiskFact({ risk: "cloud-sync" })).toEqual({ risk: "cloud-sync", migrationBlocked: true });
    expect(storageRiskFact({ risk: "unknown" })).toEqual({ risk: "unknown", migrationBlocked: false });
  });
});

describe("test-build storage override", () => {
  it("parses a prefix map and ignores anything malformed", () => {
    expect(parseStorageRiskOverride("not json").size).toBe(0);
    expect(parseStorageRiskOverride("[]").size).toBe(0);
    expect(parseStorageRiskOverride("null").size).toBe(0);
    const map = parseStorageRiskOverride(JSON.stringify({ "/a": "network", "": "network", "/b": "bogus", "/c": 3 }));
    expect([...map.entries()]).toEqual([["/a", "network"]]);
  });

  it("answers with the longest matching prefix and nothing otherwise", () => {
    const map = parseStorageRiskOverride(JSON.stringify({ "/a": "network", "/a/b": "removable" }));
    expect(overriddenStorageRisk("/a/b/x.db", map)?.risk).toBe("removable");
    expect(overriddenStorageRisk("/a/x.db", map)?.risk).toBe("network");
    expect(overriddenStorageRisk("/z/x.db", map)).toBeUndefined();
  });
});

describe("start-time policy", () => {
  function deps(risk: StorageRisk | undefined) {
    const calls: string[] = [];
    let sent: unknown;
    return {
      calls,
      sent: () => sent,
      value: {
        risk: risk === undefined ? undefined : { risk, evidence: [], symlinked: false },
        currentFacts: () => ({ activePort: 3210 }),
        stopBackend: async () => {
          calls.push("stop");
        },
        updateFacts: async (facts: unknown) => {
          sent = facts;
          calls.push("update");
          return true;
        },
      },
    };
  }

  it("leaves a failed or missing start alone", async () => {
    const d = deps("network");
    expect(await applyStartTimeStorageRisk(undefined, d.value)).toBeUndefined();
    expect(await applyStartTimeStorageRisk({ ok: false, code: "X" }, d.value)).toEqual({ ok: false, code: "X" });
    expect(await applyStartTimeStorageRisk({ ok: true }, deps(undefined).value)).toEqual({ ok: true });
    expect(d.calls).toEqual([]);
  });

  it("stops the backend and fails with the network code on a network drive", async () => {
    const d = deps("network");
    expect(await applyStartTimeStorageRisk({ ok: true }, d.value)).toEqual({ ok: false, code: "DB_STORAGE_NETWORK" });
    expect(d.calls).toEqual(["stop"]);
  });

  it("merges a risk or unknown into the facts and keeps the start", async () => {
    for (const risk of ["removable", "unknown"] as const) {
      const d = deps(risk);
      expect(await applyStartTimeStorageRisk({ ok: true }, d.value)).toEqual({ ok: true });
      expect(d.sent()).toEqual({ activePort: 3210, storageRisk: storageRiskFact({ risk }) });
    }
  });

  it("sends nothing when the storage is fine", async () => {
    const d = deps("none");
    expect(await applyStartTimeStorageRisk({ ok: true }, d.value)).toEqual({ ok: true });
    expect(d.calls).toEqual([]);
  });
});

describe("storage risk view and candidate gate", () => {
  it("builds a view per risk in both languages", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      expect(buildStorageRiskView({ risk: "none", locale, chosenByUser: true, needsMigration: false })).toBeUndefined();
      const network = buildStorageRiskView({ risk: "network", locale, chosenByUser: true, needsMigration: false });
      expect(network).toMatchObject({ refused: true, canCopyToLocal: true });
      const removable = buildStorageRiskView({ risk: "removable", locale, chosenByUser: true, needsMigration: true });
      expect(removable?.consent).toBeTruthy();
      expect(removable?.migrationNote).toBeTruthy();
      expect(removable?.canCopyToLocal).toBe(true);
      const unknown = buildStorageRiskView({ risk: "unknown", locale, chosenByUser: true, needsMigration: false });
      expect(unknown?.consent).toBeUndefined();
      expect(unknown?.canCopyToLocal).toBe(false);
      expect(
        buildStorageRiskView({ risk: "unknown", locale, chosenByUser: false, needsMigration: false })?.consent,
      ).toBeTruthy();
    }
  });

  function registry(risk: StorageRisk, needsMigration: boolean) {
    let n = 0;
    const candidates = new CandidateRegistry(() => `id${(n += 1)}`);
    const id = candidates.add("/x.db");
    candidates.setPreview(id, {
      status: "ok",
      needsMigration,
      identity: { realPath: "/x.db", fileId: null, lineageId: null },
    } as never);
    candidates.setStorageRisk(id, risk);
    return { candidates, id };
  }

  it("refuses a network file, forbids its update and asks for consent", () => {
    const network = registry("network", false);
    expect(network.candidates.checkConfirm(network.id, true, true)).toEqual({ ok: false, reason: "storage-refused" });
    const migrating = registry("removable", true);
    expect(migrating.candidates.checkConfirm(migrating.id, true, true)).toEqual({
      ok: false,
      reason: "migration-blocked-by-storage",
    });
    const plain = registry("cloud-sync", false);
    expect(plain.candidates.checkConfirm(plain.id, false, false)).toEqual({
      ok: false,
      reason: "storage-consent-required",
    });
    expect(plain.candidates.checkConfirm(plain.id, false, true).ok).toBe(true);
    const unknown = registry("unknown", true);
    expect(unknown.candidates.checkConfirm(unknown.id, false, false)).toEqual({
      ok: false,
      reason: "migration-consent-required",
    });
    expect(unknown.candidates.checkConfirm(unknown.id, true, false).ok).toBe(true);
    expect(unknown.candidates.checkConfirm("nope", true).ok).toBe(false);
  });
});
