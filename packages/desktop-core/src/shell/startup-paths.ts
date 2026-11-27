export type UserDataResolution =
  | { readonly ok: true; readonly userDataDirectory: string }
  | { readonly ok: false; readonly code: "USER_DATA_UNAVAILABLE"; readonly detail: string };

export interface UserDataAccess {
  read(): string;
  write(path: string): void;
}

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
    return { ok: true, userDataDirectory };
  } catch (error) {
    return {
      ok: false,
      code: "USER_DATA_UNAVAILABLE",
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }
}
