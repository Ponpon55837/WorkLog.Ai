export const STRICT_OPT_IN_VARIABLE = "WI_PACKAGED_STRICT";

export function isStrictPackagedRun(environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.CI === "true" || environment[STRICT_OPT_IN_VARIABLE] === "1";
}

export type InstallerProfileDecision =
  | { readonly mode: "real-profile" }
  | { readonly mode: "skip"; readonly reason: string }
  | { readonly mode: "refuse"; readonly reason: string };

// The installer's bare `--quit` reaches only an instance on the default userData, so the test needs the real profile;
// one that already exists is refused, never overwritten or removed.
export function decideInstallerProfile(
  environment: Readonly<Record<string, string | undefined>>,
  existingDefaults: readonly string[],
): InstallerProfileDecision {
  if (!isStrictPackagedRun(environment)) {
    return {
      mode: "skip",
      reason: `uses the real user profile and its --quit would close a running App: runs only with CI=true or ${STRICT_OPT_IN_VARIABLE}=1`,
    };
  }
  if (existingDefaults.length > 0) {
    return {
      mode: "refuse",
      reason: `the real default userData already exists (${existingDefaults.join(", ")}); it is neither overwritten nor removed`,
    };
  }
  return { mode: "real-profile" };
}
