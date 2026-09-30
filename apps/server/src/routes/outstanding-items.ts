import {
  batchUpdateOutstandingItemStatusInputSchema,
  webOutstandingItemListQuerySchema,
  updateOutstandingItemStatusInputSchema,
} from "@work-intelligence/schema";
import { numberParam, readJsonObject, sendError, sendJson, textParam } from "../http.js";
import { validatedRoute, type Route } from "./router.js";

export const outstandingItemRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/outstanding-items",
    handler: validatedRoute(
      webOutstandingItemListQuerySchema,
      "Invalid outstanding item filters.",
      ({ url }) => ({
        projectId: textParam(url, "projectId"),
        status: textParam(url, "status"),
        page: numberParam(url, "page"),
        pageSize: numberParam(url, "pageSize"),
        from: textParam(url, "from"),
        to: textParam(url, "to"),
      }),
      ({ store }, data) => store.listOutstandingItems(data),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/outstanding-items/batch",
    handler: async ({ request, response, store }) => {
      const parsed = batchUpdateOutstandingItemStatusInputSchema.safeParse(await readJsonObject(request));
      if (!parsed.success) {
        sendError(response, 400, "Invalid outstanding item batch.", parsed.error.flatten());
        return;
      }
      const result = store.batchUpdateOutstandingItemStatus(parsed.data);
      if (result.outcome === "rejected") {
        const conflict = result.reason === "status_conflict";
        sendError(
          response,
          conflict ? 409 : 400,
          conflict ? "Outstanding item status changed." : "Invalid outstanding item batch.",
          { reason: result.reason, invalidItemIds: result.invalidItemIds },
          conflict ? "conflict" : "invalid_input",
        );
        return;
      }
      sendJson(response, 200, result);
    },
  },
  {
    method: "PATCH",
    pattern: "/api/outstanding-items/:itemId",
    handler: validatedRoute(
      updateOutstandingItemStatusInputSchema,
      "Invalid outstanding item status.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), itemId: params.itemId }),
      ({ store }, data) => store.updateOutstandingItemStatus(data.itemId, data.status, "web"),
    ),
  },
];
