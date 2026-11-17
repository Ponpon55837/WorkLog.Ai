import { describe, expect, it } from "vitest";
import {
  STRICT_OPT_IN_VARIABLE,
  decideInstallerProfile,
  isStrictPackagedRun,
} from "../../apps/desktop/tests/packaged-smoke/installer-profile.js";

const SYNTHETIC_DEFAULT = "C:\\Users\\synthetic\\AppData\\Roaming\\Work Intelligence";

describe("whether a packaged run is strict (may act beyond its sandbox)", () => {
  it("is strict only with CI=true or the opt-in set to 1", () => {
    expect(isStrictPackagedRun({ CI: "true" })).toBe(true);
    expect(isStrictPackagedRun({ [STRICT_OPT_IN_VARIABLE]: "1" })).toBe(true);
    expect(isStrictPackagedRun({})).toBe(false);
    expect(isStrictPackagedRun({ CI: "1", [STRICT_OPT_IN_VARIABLE]: "0" })).toBe(false);
  });
});

describe("whether the installer test may use the real user profile", () => {
  it("skips on a developer's machine, with the reason", () => {
    const decision = decideInstallerProfile({}, []);
    expect(decision.mode).toBe("skip");
    expect(decision).toMatchObject({ reason: expect.stringContaining(`${STRICT_OPT_IN_VARIABLE}=1`) });
  });

  it("skips when CI is set to anything but true and there is no opt-in", () => {
    expect(decideInstallerProfile({ CI: "1" }, []).mode).toBe("skip");
    expect(decideInstallerProfile({ CI: "false", [STRICT_OPT_IN_VARIABLE]: "0" }, []).mode).toBe("skip");
  });

  it("uses the real profile on CI or with the opt-in when no default userData exists", () => {
    expect(decideInstallerProfile({ CI: "true" }, [])).toEqual({ mode: "real-profile" });
    expect(decideInstallerProfile({ [STRICT_OPT_IN_VARIABLE]: "1" }, [])).toEqual({ mode: "real-profile" });
  });

  it("refuses, even on CI, when a default userData already exists, and names it", () => {
    for (const environment of [{ CI: "true" }, { [STRICT_OPT_IN_VARIABLE]: "1" }]) {
      const decision = decideInstallerProfile(environment, [SYNTHETIC_DEFAULT]);
      expect(decision.mode).toBe("refuse");
      expect(decision).toMatchObject({ reason: expect.stringContaining(SYNTHETIC_DEFAULT) });
    }
  });
});
