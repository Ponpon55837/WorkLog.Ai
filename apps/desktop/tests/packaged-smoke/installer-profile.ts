/**
 * Whether the installer-over-the-running-App test may use the real user profile. The installer asks the running App to
 * quit with a bare `<exe> --quit`, which reaches only an instance on the default userData, so the test must run the App
 * on the real profile (no `--user-data-dir`). On a developer's machine that is the user's own settings, database, log
 * and single-instance lock, and the installer's `--quit` would close the App they are using. So the test runs only on
 * CI (`CI=true`) or when asked for (`WI_PACKAGED_STRICT=1`), and even then only while no default userData exists: a
 * folder that is already there is refused, never overwritten or removed. No Playwright import, so unit tests load it.
 */

export const STRICT_OPT_IN_VARIABLE = "WI_PACKAGED_STRICT";

export type InstallerProfileDecision =
  | { readonly mode: "real-profile" }
  | { readonly mode: "skip"; readonly reason: string }
  | { readonly mode: "refuse"; readonly reason: string };

/**
 * `real-profile` on CI or with the opt-in when none of `existingDefaults` (the default userData folders that exist now) is there;
 * `skip` without CI or opt-in; `refuse` when a default userData folder exists.
 */
export function decideInstallerProfile(
  environment: Readonly<Record<string, string | undefined>>,
  existingDefaults: readonly string[],
): InstallerProfileDecision {
  if (environment.CI !== "true" && environment[STRICT_OPT_IN_VARIABLE] !== "1") {
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
