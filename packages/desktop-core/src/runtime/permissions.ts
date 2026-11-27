export type AclCheck = "checked" | "skipped";

export interface PermissionPolicy {
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
}

export interface EntryOwnership {
  readonly mode: number;
  readonly uid: number;
}

const WORLD_WRITABLE = 0o002;

export function currentPermissionPolicy(): PermissionPolicy {
  return { platform: process.platform, uid: process.getuid?.() };
}

export function permissionProblem(entry: EntryOwnership, policy: PermissionPolicy): string | undefined {
  if (policy.platform === "win32") return undefined;
  if ((entry.mode & WORLD_WRITABLE) !== 0) return `可被任何使用者寫入（mode ${(entry.mode & 0o7777).toString(8)}）`;
  if (policy.uid !== undefined && entry.uid !== policy.uid) {
    return `擁有者是 uid ${entry.uid}，不是目前使用者 uid ${policy.uid}`;
  }
  return undefined;
}
