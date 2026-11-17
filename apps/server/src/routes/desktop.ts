import { z } from "zod";
import { readJsonBody, sendError, sendJson } from "../http.js";
import { parseRequestInput, type Route } from "./router.js";

/** The request carries nothing; an unknown field is refused like on every other mutating route. */
const openAgentSetupInputSchema = z.strictObject({});

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
];
