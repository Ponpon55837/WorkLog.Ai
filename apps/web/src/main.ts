import { createApp } from "vue";
import { PiniaColada } from "@pinia/colada";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import "./styles/tokens.css";
import "./styles/base.css";

createApp(App).use(createPinia()).use(PiniaColada).use(router).mount("#app");
