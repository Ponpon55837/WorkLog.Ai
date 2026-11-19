/**
 * Whether permissions were actually checked. Every platform checks something real: POSIX owner and mode bits, Windows
 * ACLs (see windows-acl.ts). A check that cannot run throws; it never reports a pass. `skipped` only when the caller asked
 * for a content-only verification (`checkAcl: false`, build machines).
 */
export type AclCheck = "checked" | "skipped";

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

/**
 * Only world-writable is refused, group-writable is allowed on purpose (L-17): the entries are owned by the current
 * user (checked below), and many Linux setups create files with umask 002 in a private per-user group (mode 664), so
 * refusing group-write would reject a runtime the App itself just installed.
 */
const WORLD_WRITABLE = 0o002;

/** The real platform and uid of this process. */
export function currentPermissionPolicy(): PermissionPolicy {
  return { platform: process.platform, uid: process.getuid?.() };
}

/** Why an entry cannot be trusted (world-writable, or owned by someone else; POSIX only), or undefined. Symlinks are skipped by the caller. */
export function permissionProblem(entry: EntryOwnership, policy: PermissionPolicy): string | undefined {
  // Node reports mode 666 and uid 0 for every Windows entry: the ACL check (windows-acl.ts) is the real one there.
  if (policy.platform === "win32") return undefined;
  if ((entry.mode & WORLD_WRITABLE) !== 0) return `可被任何使用者寫入（mode ${(entry.mode & 0o7777).toString(8)}）`;
  if (policy.uid !== undefined && entry.uid !== policy.uid) {
    return `擁有者是 uid ${entry.uid}，不是目前使用者 uid ${policy.uid}`;
  }
  return undefined;
}
