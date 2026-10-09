import { attentionQuerySchema } from "@work-intelligence/schema";
import { validatedRoute, type Route } from "./router.js";

/** Read-only aggregate; actions stay on policy-gated domain routes. */
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
];
