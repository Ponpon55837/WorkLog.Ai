/** Why the App could not find where its data lives; it closes with a native error box instead of loading half-way. */
export type UserDataResolution =
  | { readonly ok: true; readonly userDataDirectory: string }
  | { readonly ok: false; readonly code: "USER_DATA_UNAVAILABLE"; readonly detail: string };

/** Electron's `app.getPath("userData")` and `app.setPath("userData", …)`, injected so the decision runs anywhere. */
export interface UserDataAccess {
  /** Throws when the platform cannot name the folder (on Windows, a missing Roaming AppData). */
  read(): string;
  write(path: string): void;
  /**
   * Windows only: whether the folder that holds the default data folder (Roaming AppData) exists. Electron may name the
   * default without it, then stop at a native check before `ready`; so a missing one is refused here, while the App
   * can still say why. Not set elsewhere: macOS and Linux create the default folder themselves.
   */
  parentExists?(userDataDirectory: string): boolean;
}

/**
 * Where the App keeps its data, or why it cannot know. A redirect (dev and test only) is applied first, so the platform
 * default is never resolved when it is not used. Never throws: the caller decides how to tell the user and exits.
 */
export function resolveUserDataDirectory(override: string | undefined, access: UserDataAccess): UserDataResolution {
  if (override) {
    try {
      access.write(override);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return { ok: false, code: "USER_DATA_UNAVAILABLE", detail: `the data folder redirect was refused: ${reason}` };
    }
  }
  try {
    const userDataDirectory = access.read();
    if (userDataDirectory.trim() === "") {
      return { ok: false, code: "USER_DATA_UNAVAILABLE", detail: "the platform returned an empty path" };
    }
    // A redirect is created by the App itself; only the platform default depends on a folder the profile must have.
    if (!override && access.parentExists && !access.parentExists(userDataDirectory)) {
      return {
        ok: false,
        code: "USER_DATA_UNAVAILABLE",
        detail: "the folder that holds the application data does not exist",
      };
    }
    return { ok: true, userDataDirectory };
  } catch (error) {
    return {
      ok: false,
      code: "USER_DATA_UNAVAILABLE",
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }
}
