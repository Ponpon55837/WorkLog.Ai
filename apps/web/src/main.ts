import { createApp } from "vue";
import { PiniaColada } from "@pinia/colada";
import { createPinia } from "pinia";
import { z } from "zod";
import App from "./App.vue";
import { router } from "./router";
import { usePreferencesStore } from "./stores/preferences";
import { localeReady } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";

z.config({ jitless: true });

const pinia = createPinia();

// The saved language is applied when the preferences store is created; its catalog may still be downloading, and the
// boot splash stays up until it lands so the first paint is already in the right language.
usePreferencesStore(pinia);
void localeReady().then(() => createApp(App).use(pinia).use(PiniaColada).use(router).mount("#app"));
