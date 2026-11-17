import { consumePortHandoff } from "./utils/port-handoff";

/**
 * After a port change the App opens this page at the new address with the preferences in the URL fragment. They are
 * stored under the usual keys and the fragment is removed here, as a side effect of importing this module. It must be
 * imported before `./router` (and before anything that imports it): `createWebHistory` captures the location, hash
 * included, when the router is created, so a fragment still in the address bar would survive the first redirect.
 */
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
