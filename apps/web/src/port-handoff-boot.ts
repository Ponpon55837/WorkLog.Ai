import { consumePortHandoff } from "./utils/port-handoff";

/** Must be imported before `./router`: `createWebHistory` captures the location, hash included, so a leftover fragment would survive the first redirect. */
export const handoffRoute: string | undefined = consumePortHandoff({
  hash: window.location.hash,
  pathname: window.location.pathname,
  search: window.location.search,
  storage: (() => {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  })(),
  replaceUrl: (url) => window.history.replaceState(null, "", url),
});
