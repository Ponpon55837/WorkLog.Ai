/**
 * Gives a test directory the Windows ACL the product's launcher-root check accepts (current user, SYSTEM and
 * Administrators only); the product check is never loosened for tests. Does nothing on macOS and Linux.
 */
import { execFileSync } from "node:child_process";
import process from "node:process";
import { windowsSystemTool } from "../../packages/shared/dist/windows-system-tool.js";

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const BUILTIN_USERS_SID = "S-1-5-32-545";
const SID_PATTERN = /"(S-1-\d+(?:-\d+)+)"\s*$/;
const COMMAND_TIMEOUT_MS = 30_000;

let cachedUserSid;

export function parseWhoamiSid(output) {
  const sid = output.trim().match(SID_PATTERN)?.[1];
  if (sid === undefined) throw new Error(`no SID in the whoami output: ${output.trim()}`);
  return sid;
}

/** Well-known SIDs are written `*S-1-...`, so no locale-dependent account name is involved. */
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

export function builtinUsersWriteArguments(directory) {
  return [directory, "/grant", `*${BUILTIN_USERS_SID}:(OI)(CI)M`];
}

/** Runs a System32 tool by absolute path (never PATH: Git for Windows ships its own `whoami.exe`) with an argument array, no shell. */
function runWindowsTool(name, args) {
  return execFileSync(windowsSystemTool(name), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}

export function currentUserSid() {
  cachedUserSid ??= parseWhoamiSid(runWindowsTool("whoami.exe", ["/user", "/fo", "csv", "/nh"]));
  return cachedUserSid;
}

export function securePrivateDirectory(directory) {
  if (process.platform !== "win32") return directory;
  runWindowsTool("icacls.exe", privateDirectoryAclArguments(directory, currentUserSid()));
  return directory;
}

export function allowBuiltinUsersToWrite(directory) {
  if (process.platform !== "win32") return directory;
  runWindowsTool("icacls.exe", builtinUsersWriteArguments(directory));
  return directory;
}
