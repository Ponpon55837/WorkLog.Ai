/** Whether permissions were actually checked; Windows ACLs are not inspected yet and say so instead of passing. */
export type AclCheck = "checked" | "not-implemented";

/** The platform facts a permission check depends on; injectable so tests cover every platform on one machine. */
export interface PermissionPolicy {
  readonly platform: NodeJS.Platform;
  /** The current user's uid, or undefined where the platform has none (Windows). */
  readonly uid: number | undefined;
}

/** The mode bits and owner of one file system entry. */
export interface EntryOwnership {
  readonly mode: number;
  readonly uid: number;
}

const WORLD_WRITABLE = 0o002;

/** The real platform and uid of this process. */
export function currentPermissionPolicy(): PermissionPolicy {
  return { platform: process.platform, uid: process.getuid?.() };
}

/**
 * Which kind of permission check this policy performs. TODO(Windows): inspect the ACLs (owner, and no write access
 * for other principals) before the Windows installer ships; until then the result is `not-implemented`, never a pass.
 */
export function aclCheckFor(policy: PermissionPolicy): AclCheck {
  return policy.platform === "win32" ? "not-implemented" : "checked";
}

/** Why an entry cannot be trusted (world-writable, or owned by someone else), or undefined. Symlinks are skipped by the caller. */
export function permissionProblem(entry: EntryOwnership, policy: PermissionPolicy): string | undefined {
  if (aclCheckFor(policy) === "not-implemented") return undefined;
  if ((entry.mode & WORLD_WRITABLE) !== 0) return `可被任何使用者寫入（mode ${(entry.mode & 0o7777).toString(8)}）`;
  if (policy.uid !== undefined && entry.uid !== policy.uid) {
    return `擁有者是 uid ${entry.uid}，不是目前使用者 uid ${policy.uid}`;
  }
  return undefined;
}
