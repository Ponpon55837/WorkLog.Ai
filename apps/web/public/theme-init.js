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
  // After a port change the desktop App opens this page at the new address with the theme in the URL fragment
  // (#wi-handoff=<base64url JSON>); the new origin has no saved theme yet. Only the theme is read here, and the app
  // (utils/port-handoff.ts) stores the preferences and clears the fragment.
  try {
    var hash = window.location.hash;
    if (hash.indexOf("#wi-handoff=") === 0 && hash.length <= 4200) {
      var base64 = hash.slice(12).replace(/-/g, "+").replace(/_/g, "/");
      while (base64.length % 4) base64 += "=";
      var payload = JSON.parse(decodeURIComponent(escape(window.atob(base64))));
      var handed = payload && payload.v === 1 && payload.preferences ? payload.preferences.theme : undefined;
      if (handed === "light" || handed === "dark" || handed === "system") preference = handed;
    }
  } catch {
    // Not a valid handoff: keep the saved preference.
  }
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var theme = preference === "light" || preference === "dark" ? preference : dark ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
})();
