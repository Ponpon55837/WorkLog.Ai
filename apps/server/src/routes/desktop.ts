import { openPortSettingsInputSchema, SHELL_LOCALES } from "@work-intelligence/schema";
import { z } from "zod";
import { readJsonBody, sendError, sendJson } from "../http.js";
import { parseRequestInput, type Route } from "./router.js";

/** The request carries nothing; an unknown field is refused like on every other mutating route. */
const openAgentSetupInputSchema = z.strictObject({});

/** The Dashboard language the user picked, already mapped to the App's locale names. */
const setLanguageInputSchema = z.strictObject({ locale: z.enum(SHELL_LOCALES) });

/** Routes that only exist when the desktop App runs this server as its child. */
export const desktopRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/desktop/open-agent-setup",
    handler: async ({ request, response, services }) => {
      // JSON-only like every POST, so a cross-site form cannot make the App open a window.
      const parsed = parseRequestInput(openAgentSetupInputSchema, (await readJsonBody(request)) ?? {});
      if (!parsed.success) {
        sendError(response, 400, "Invalid request body.", parsed.error.flatten(), "invalid_input");
        return;
      }
      if (!services.desktop) {
        sendError(response, 404, "只有桌面 App 管理的後端提供這個功能。");
        return;
      }
      // Only asks the App to show its window; the App, not the server, decides and writes any Agent config.
      services.desktop.requestOpenAgentSetup();
      sendJson(response, 202, { ok: true });
    },
  },
  {
    method: "POST",
    pattern: "/api/desktop/open-port-settings",
    handler: async ({ request, response, services }) => {
      const parsed = parseRequestInput(openPortSettingsInputSchema, (await readJsonBody(request)) ?? {});
      if (!parsed.success) {
        sendError(response, 400, "Invalid request body.", parsed.error.flatten(), "invalid_input");
        return;
      }
      if (!services.desktop) {
        sendError(response, 404, "只有桌面 App 管理的後端提供這個功能。");
        return;
      }
      // The App confirms the change itself; the page only hands over its whitelisted preferences and route.
      services.desktop.requestOpenPortSettings({
        ...(parsed.data.preferences === undefined ? {} : { preferences: parsed.data.preferences }),
        ...(parsed.data.route === undefined ? {} : { route: parsed.data.route }),
      });
      sendJson(response, 202, { ok: true });
    },
  },
  {
    method: "POST",
    pattern: "/api/desktop/language",
    handler: async ({ request, response, services }) => {
      const parsed = parseRequestInput(setLanguageInputSchema, (await readJsonBody(request)) ?? {});
      if (!parsed.success) {
        sendError(response, 400, "Invalid request body.", parsed.error.flatten(), "invalid_input");
        return;
      }
      if (!services.desktop) {
        sendError(response, 404, "只有桌面 App 管理的後端提供這個功能。");
        return;
      }
      // The App owns the setting; it saves the locale and pushes updated facts back.
      services.desktop.requestSetLanguage(parsed.data.locale);
      sendJson(response, 202, { ok: true });
    },
  },
];
