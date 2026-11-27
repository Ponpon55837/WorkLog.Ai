import { openPortSettingsInputSchema, SHELL_LOCALES } from "@work-intelligence/schema";
import { z } from "zod";
import { readJsonBody, sendError, sendJson } from "../http.js";
import { parseRequestInput, type Route } from "./router.js";

const openAgentSetupInputSchema = z.strictObject({});

const setLanguageInputSchema = z.strictObject({ locale: z.enum(SHELL_LOCALES) });

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
      services.desktop.requestSetLanguage(parsed.data.locale);
      sendJson(response, 202, { ok: true });
    },
  },
];
