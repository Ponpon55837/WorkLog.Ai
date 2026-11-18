// First on purpose: the handoff fragment must be gone before the router captures the location.
import { handoffRoute } from "./port-handoff-boot";
import { createApp } from "vue";
import { PiniaColada } from "@pinia/colada";
import { createPinia } from "pinia";
import { z } from "zod";
import App from "./App.vue";
import { router } from "./router";
import { usePreferencesStore } from "./stores/preferences";
import { gateHandoffRoute } from "./utils/port-handoff";
import { localeReady } from "./i18n";
import "@work-intelligence/ui-tokens/tokens.css";
import "./styles/base.css";

z.config({ jitless: true });

const pinia = createPinia();

// The saved language is applied when the preferences store is created; its catalog may still be downloading, and the
// boot splash stays up until it lands so the first paint is already in the right language.
usePreferencesStore(pinia);
void localeReady().then(async () => {
  const app = createApp(App).use(pinia).use(PiniaColada).use(router);
  if (handoffRoute !== undefined)
    await router.replace(gateHandoffRoute(handoffRoute, (route) => router.resolve(route)));
  app.mount("#app");
});
