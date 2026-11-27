import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

/** Created exclusively (EEXIST when another build holds it); the returned content is this build's proof of ownership. */
export function createBuildMarker(markerPath, owner) {
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), package: owner });
  const markerFd = openSync(markerPath, "wx", 0o600);
  try {
    writeFileSync(markerFd, content);
  } catch (error) {
    closeSync(markerFd);
    // The empty marker is ours; leaving it would block every later build.
    rmSync(markerPath, { force: true });
    throw error;
  }
  closeSync(markerFd);
  return content;
}

/** Removes the marker only while it still holds this build's content; a marker another build created is left alone. */
export function removeOwnBuildMarker(markerPath, content) {
  let current;
  try {
    current = readFileSync(markerPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (current !== content) return false;
  rmSync(markerPath, { force: true });
  return true;
}
