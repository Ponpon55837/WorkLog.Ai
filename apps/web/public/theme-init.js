// Applies the saved colour theme before the first paint so a light-theme user never sees a dark flash.
// Kept as a same-origin file because the production Content-Security-Policy forbids inline scripts.
// The app (composables/useAppearance.ts) takes over once it loads.
/* global window, document */
(function () {
  var preference = "system";
  try {
    preference = window.localStorage.getItem("work-intelligence:theme") || "system";
  } catch {
    // Storage blocked: follow the system setting.
  }
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var theme = preference === "light" || preference === "dark" ? preference : dark ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
})();
