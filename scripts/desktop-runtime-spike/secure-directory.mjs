/**
 * Gives a test directory the ACL of the App's real launcher root on Windows, so the product's fail-closed permission
 * check (packages/desktop-core/src/runtime/windows-acl.ts) accepts it. A Windows runner's temp folders grant
 * BUILTIN\Users write access, which the check rightly refuses; the product check is never loosened for tests.
 *
 * The root under %LOCALAPPDATA% has inheritance removed and only the current user, SYSTEM and Administrators, each with
 * full control that children inherit. `securePrivateDirectory` reproduces that and does nothing on macOS and Linux,
 * where the POSIX owner and mode check already passes for folders made by `mkdtemp` and `mkdir`.
 *
 * Shared by the runtime spike scripts, the desktop smoke runners and the desktop-core tests (all import this file).
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const BUILTIN_USERS_SID = "S-1-5-32-545";
const SID_PATTERN = /"(S-1-\d+(?:-\d+)+)"\s*$/;
const COMMAND_TIMEOUT_MS = 30_000;

let cachedUserSid;

/** The SID in the output of `whoami /user /fo csv /nh` (`"HOST\user","S-1-5-21-..."`). Throws when there is none. */
export function parseWhoamiSid(output) {
  const sid = output.trim().match(SID_PATTERN)?.[1];
  if (sid === undefined) throw new Error(`no SID in the whoami output: ${output.trim()}`);
  return sid;
}

/**
 * The icacls arguments that lock `directory`: inheritance removed (`/inheritance:r` drops the inherited entries) and full
 * control, inherited by files and folders, for only the current user, SYSTEM and Administrators. Well-known SIDs are
 * written `*S-1-...`, so no locale-dependent account name is involved.
 */
export function privateDirectoryAclArguments(directory, userSid) {
  return [
    directory,
    "/inheritance:r",
    "/grant:r",
    `*${userSid}:(OI)(CI)F`,
    `*${SYSTEM_SID}:(OI)(CI)F`,
    `*${ADMINISTRATORS_SID}:(OI)(CI)F`,
  ];
}

/** The icacls arguments that let every local user modify `directory`'s tree: the unsafe case the product must refuse. */
export function builtinUsersWriteArguments(directory) {
  return [directory, "/grant", `*${BUILTIN_USERS_SID}:(OI)(CI)M`];
}

/** `execFileSync` with an argument array (no shell), so paths with spaces and non-ASCII characters pass unchanged. */
function runWindowsTool(file, args) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}

function currentUserSid() {
  cachedUserSid ??= parseWhoamiSid(runWindowsTool("whoami", ["/user", "/fo", "csv", "/nh"]));
  return cachedUserSid;
}

/** Restricts `directory` to the current user, SYSTEM and Administrators on Windows (see the file comment); returns it. */
export function securePrivateDirectory(directory) {
  if (process.platform !== "win32") return directory;
  runWindowsTool("icacls", privateDirectoryAclArguments(directory, currentUserSid()));
  return directory;
}

/** Grants BUILTIN\Users modify on `directory` and below on Windows, for the negative test; does nothing elsewhere. */
export function allowBuiltinUsersToWrite(directory) {
  if (process.platform !== "win32") return directory;
  runWindowsTool("icacls", builtinUsersWriteArguments(directory));
  return directory;
}
