import { session } from "electron";
import type { UpdateFetch } from "@work-intelligence/desktop-core";

/**
 * The session the check uses: a partition without the `persist:` prefix, so it lives in memory only (no cookie or cache
 * reaches the disk) and is separate from the repair window's. It is made on the first check, not at start-up.
 */
const UPDATE_PARTITION = "update-check";

/**
 * Electron's `net.fetch` always uses the default session; `session.fetch` sends through this one. `credentials: "omit"`
 * keeps cookies out, `redirect: "error"` refuses any redirect.
 */
export function createUpdateSessionFetch(): UpdateFetch {
  return (url, init) => session.fromPartition(UPDATE_PARTITION).fetch(url, init);
}
