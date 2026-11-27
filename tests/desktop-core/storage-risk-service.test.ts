import { describe, expect, it } from "vitest";
import { createStorageRiskService } from "../../apps/desktop/src/main/storage-risk.js";
import type { StorageRiskResult } from "../../packages/desktop-core/src/index.js";

const NETWORK: StorageRiskResult = { risk: "network", evidence: ["synthetic"], symlinked: false };

describe("the storage verdict service", () => {
  it("answers `unknown` when the detection hangs (a dead share), and drops the late answer", async () => {
    let release: (result: StorageRiskResult) => void = () => undefined;
    const service = createStorageRiskService({
      timeoutMs: 20,
      classifier: () =>
        new Promise<StorageRiskResult>((resolve) => {
          release = resolve;
        }),
    });
    const result = await service.classify("/synthetic/hung.sqlite");
    expect(result).toMatchObject({ risk: "unknown", evidence: ["classifier-timeout"] });
    release(NETWORK);
    await Promise.resolve();
    expect(service.last("/synthetic/hung.sqlite")?.risk).toBe("unknown");
  });

  it("remembers the verdict it reached, and reports a classifier that throws as unknown", async () => {
    const answers = new Map<string, StorageRiskResult | Error>([
      ["/synthetic/share.sqlite", NETWORK],
      ["/synthetic/broken.sqlite", new Error("boom")],
    ]);
    const service = createStorageRiskService({
      classifier: async (path) => {
        const answer = answers.get(path);
        if (answer instanceof Error || answer === undefined) throw answer ?? new Error("missing");
        return answer;
      },
    });
    expect((await service.classify("/synthetic/share.sqlite")).risk).toBe("network");
    expect(service.last("/synthetic/share.sqlite")?.risk).toBe("network");
    expect(service.fact("/synthetic/share.sqlite")).toMatchObject({ risk: "network", migrationBlocked: true });
    expect(await service.classify("/synthetic/broken.sqlite")).toMatchObject({ risk: "unknown" });
    expect(service.last("/synthetic/never.sqlite")).toBeUndefined();
  });
});
