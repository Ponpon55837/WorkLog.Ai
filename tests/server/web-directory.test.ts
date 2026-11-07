import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveWebDirectory } from "../../apps/server/src/web-directory.js";

const bundleUrl = pathToFileURL(resolve("/pkg/libexec/apps/server/dist/standalone-cli.js")).href;
const packagedWeb = resolve("/pkg/web");

describe("resolveWebDirectory", () => {
  it("lets WORK_INTELLIGENCE_WEB_DIST win in both modes", () => {
    const environment = { WORK_INTELLIGENCE_WEB_DIST: "/custom/web" };
    expect(resolveWebDirectory({ environment, standalone: false })).toBe("/custom/web");
    expect(resolveWebDirectory({ environment, standalone: true, moduleUrl: bundleUrl, exists: () => true })).toBe(
      "/custom/web",
    );
  });

  it("serves no Web UI from a checkout unless the environment says where it is", () => {
    expect(resolveWebDirectory({ environment: {}, standalone: false, moduleUrl: bundleUrl, exists: () => true })).toBe(
      undefined,
    );
  });

  it("defaults a standalone package to its own web/ folder, found from the bundle's location", () => {
    const checked: string[] = [];
    const directory = resolveWebDirectory({
      environment: {},
      standalone: true,
      moduleUrl: bundleUrl,
      exists: (path) => {
        checked.push(path);
        return true;
      },
    });
    expect(directory).toBe(packagedWeb);
    expect(checked).toEqual([resolve(packagedWeb, "index.html")]);
  });

  it("serves no Web UI from an incomplete package", () => {
    expect(
      resolveWebDirectory({ environment: {}, standalone: true, moduleUrl: bundleUrl, exists: () => false }),
    ).toBeUndefined();
  });

  it("treats an empty variable as unset", () => {
    expect(
      resolveWebDirectory({
        environment: { WORK_INTELLIGENCE_WEB_DIST: "" },
        standalone: true,
        moduleUrl: bundleUrl,
        exists: () => true,
      }),
    ).toBe(packagedWeb);
  });
});
