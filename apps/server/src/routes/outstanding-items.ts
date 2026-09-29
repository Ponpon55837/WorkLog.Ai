import { outstandingItemListQuerySchema, updateOutstandingItemStatusInputSchema } from "@work-intelligence/schema";
import { numberParam, readJsonObject, textParam } from "../http.js";
import { validatedRoute, type Route } from "./router.js";

export const outstandingItemRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/outstanding-items",
    handler: validatedRoute(
      outstandingItemListQuerySchema,
      "Invalid outstanding item filters.",
      ({ url }) => ({
        projectId: textParam(url, "projectId"),
        status: textParam(url, "status"),
        page: numberParam(url, "page"),
        pageSize: numberParam(url, "pageSize"),
      }),
      ({ store }, data) => store.listOutstandingItems(data),
    ),
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
