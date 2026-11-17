import { createApp } from "vue";
import { PiniaColada } from "@pinia/colada";
import { createPinia } from "pinia";
import { z } from "zod";
import App from "./App.vue";
import { router } from "./router";
import { usePreferencesStore } from "./stores/preferences";
import { consumePortHandoff } from "./utils/port-handoff";
import { localeReady } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";

z.config({ jitless: true });

/** A route from the App's port handoff is opened only when it matches a real page, never the catch-all. */
function isKnownRoute(route: string): boolean {
  const { matched } = router.resolve(route);
  return matched.length > 0 && matched.every((record) => !record.path.includes(":pathMatch("));
}

// After a port change the App opens this page at the new address with the preferences in the URL fragment. They are
// stored under the usual keys before the preferences store reads them, and the fragment is removed right away.
const handoffRoute = consumePortHandoff({
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

const pinia = createPinia();

// The saved language is applied when the preferences store is created; its catalog may still be downloading, and the
// boot splash stays up until it lands so the first paint is already in the right language.
usePreferencesStore(pinia);
void localeReady().then(async () => {
  const app = createApp(App).use(pinia).use(PiniaColada).use(router);
  if (handoffRoute !== undefined) await router.replace(isKnownRoute(handoffRoute) ? handoffRoute : "/");
  app.mount("#app");
});
