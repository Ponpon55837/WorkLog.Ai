import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
// @ts-expect-error the bundler options live in a plain .mjs script with no declaration file
import { bundleOptions } from "../../scripts/build-plugin.mjs";

// The desktop child's test-only migration hold must exist in a bundle only when `__WI_DESKTOP_TEST_BUILD__` is true.
const ENTRY = fileURLToPath(new URL("../../apps/server/src/desktop-child.ts", import.meta.url));
const HOLD_VARIABLE = "WORK_INTELLIGENCE_TEST_HOLD_MIGRATION_FILE";

async function bundled(testBuild: boolean): Promise<string> {
  const options = bundleOptions as { define: Record<string, string> } & Record<string, unknown>;
  const define =
    testBuild === undefined ? options.define : { ...options.define, __WI_DESKTOP_TEST_BUILD__: String(testBuild) };
  const result = await build({
    ...options,
    define,
    entryPoints: [ENTRY],
    outfile: join("virtual", "desktop-child.js"),
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

describe("the desktop child bundle", () => {
  it("carries no hold code and no hold variable name when the test flag is false", async () => {
    expect(await bundled(false)).not.toContain(HOLD_VARIABLE);
  }, 60_000);

  it("carries the hold only when the test flag is true", async () => {
    expect(await bundled(true)).toContain(HOLD_VARIABLE);
  }, 60_000);
});
