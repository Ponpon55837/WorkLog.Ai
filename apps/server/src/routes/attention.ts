import { AttentionPreferenceError } from "@work-intelligence/storage";
import { attentionQuerySchema, updateAttentionPreferenceSchema } from "@work-intelligence/schema";
import { readJsonObject, sendError } from "../http.js";
import { validatedRoute, type Route } from "./router.js";

function guarded(handler: Route["handler"]): Route["handler"] {
  return async (context) => {
    try {
      await handler(context);
    } catch (error) {
      if (!(error instanceof AttentionPreferenceError)) throw error;
      sendError(
        context.response,
        error.code === "conflict" ? 409 : 404,
        error.code === "conflict"
          ? "Attention source or preference changed. Reload before saving."
          : "Attention source unavailable.",
        undefined,
        error.code,
      );
    }
  };
}
/** Policy-gated pointers and Web-only display intents; source actions stay in their domain. */
export const attentionRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/attention",
    handler: validatedRoute(
      attentionQuerySchema,
      "Invalid attention query.",
      ({ url }) => Object.fromEntries(url.searchParams),
      ({ store }, data) => store.getAttention(data),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/attention/preferences",
    handler: guarded(
      validatedRoute(
        updateAttentionPreferenceSchema,
        "Invalid attention preference.",
        async ({ request }) => await readJsonObject(request),
        ({ store }, data) => store.updateAttentionPreference(data),
      ),
    ),
  },
];
