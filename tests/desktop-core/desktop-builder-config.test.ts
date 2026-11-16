import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuilderConfig } from "../../apps/desktop/electron-builder.config.mjs";

type Configuration = ReturnType<typeof createBuilderConfig>;
type MergeConfigs = (configs: Configuration[]) => Configuration;

const desktopDirectory = resolve(import.meta.dirname, "../../apps/desktop");
const builderRequire = createRequire(createRequire(join(desktopDirectory, "package.json")).resolve("electron-builder"));
const { doMergeConfigs } = builderRequire("app-builder-lib/out/util/config/config.js") as {
  doMergeConfigs: MergeConfigs;
};

const FILE_SETS = ["files", "extraResources", "extraFiles"] as const;
const VARIANTS = [false, true].flatMap((baseline) =>
  (["store", "normal", "maximum"] as const).flatMap((compression) =>
    (["UDZO", "ULFO"] as const).map((dmgFormat) => ({ baseline, compression, dmgFormat })),
  ),
);

function configFor(variant: (typeof VARIANTS)[number]): Configuration {
  return createBuilderConfig({
    stageDirectory: "/synthetic/stage",
    runtimeBundleDirectory: "/synthetic/runtime-bundle",
    outputDirectory: "/synthetic/out",
    version: "0.0.0",
    ...variant,
  });
}

function fileSetEntries(config: Configuration): unknown[] {
  const record = config as Record<string, unknown>;
  return FILE_SETS.flatMap((name) => {
    const value = record[name];
    return value == null ? [] : Array.isArray(value) ? value : [value];
  });
}

describe("electron-builder config", () => {
  it.each(VARIANTS)("has no null file-set entry and merges cleanly (%o)", (variant) => {
    const config = configFor(variant);
    expect(fileSetEntries(config)).not.toContain(null);
    expect(() => doMergeConfigs([{ ...config }])).not.toThrow();
  });

  it("tells electron-builder that dependencies are handled outside it, so it skips the node_modules search", async () => {
    const config = configFor(VARIANTS[0]!) as { beforeBuild?: () => Promise<boolean>; npmRebuild?: boolean };
    // beforeBuild is only consulted while npmRebuild is on (its default).
    expect(config.npmRebuild).not.toBe(false);
    expect(await config.beforeBuild?.()).toBe(false);
  });

  it("is a new object on every call, because electron-builder normalizes file sets in place", () => {
    const variant = VARIANTS[0]!;
    const first = configFor(variant);
    // build() merges the options' config into its own object first, so the normalized arrays are the caller's arrays.
    doMergeConfigs([{ ...first }]);
    // The merged string entries are now null: the same config passed to a second build() fails in normalizeFiles.
    expect(fileSetEntries(first)).toContain(null);
    expect(() => doMergeConfigs([{ ...first }])).toThrow(TypeError);

    const second = configFor(variant);
    expect(fileSetEntries(second)).not.toContain(null);
    expect(() => doMergeConfigs([{ ...second }])).not.toThrow();
  });
});
