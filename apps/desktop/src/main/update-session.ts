import { session, type Session } from "electron";
import type { UpdateFetch } from "@work-intelligence/desktop-core";

/**
 * The session the check uses: a partition without the `persist:` prefix, so it lives in memory only (no cookie or cache
 * reaches the disk) and is separate from the repair window's. It is made on the first check, not at start-up.
 */
const UPDATE_PARTITION = "update-check";

/**
 * Request headers the browser stack adds by itself and that tell the server about the user: the interface language
 * (`Accept-Language`) and nothing else the check sends is allowed to carry anything of the kind. They are removed from
 * every request of this session before it leaves.
 */
const USER_HEADERS = ["accept-language"];

let configured: Session | null = null;

function updateSession(): Session {
  if (configured) return configured;
  const ses = session.fromPartition(UPDATE_PARTITION);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const name of Object.keys(requestHeaders)) {
      if (USER_HEADERS.includes(name.toLowerCase())) delete requestHeaders[name];
    }
    callback({ requestHeaders });
  });
  configured = ses;
  return ses;
}

/**
 * Electron's `net.fetch` always uses the default session; `session.fetch` sends through this one. `credentials: "omit"`
 * keeps cookies out, `redirect: "error"` refuses any redirect.
 */
export function createUpdateSessionFetch(): UpdateFetch {
  return (url, init) => updateSession().fetch(url, init);
}
