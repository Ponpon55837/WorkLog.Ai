import { session, type Session } from "electron";
import type { UpdateFetch } from "@work-intelligence/desktop-core";

// No `persist:` prefix: the session lives in memory only and is separate from the repair window's.
const UPDATE_PARTITION = "update-check";

// Headers the browser stack adds that tell the server about the user; stripped from every request.
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

// Electron's `net.fetch` always uses the default session; `session.fetch` sends through this one.
export function createUpdateSessionFetch(): UpdateFetch {
  return (url, init) => updateSession().fetch(url, init);
}
