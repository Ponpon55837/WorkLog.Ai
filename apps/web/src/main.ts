import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { startAppRefreshEvents } from "./composables/useAppRefresh";
import "./styles/tokens.css";
import "./styles/base.css";

startAppRefreshEvents();
createApp(App).use(router).mount("#app");
