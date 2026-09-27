import { backfillRoutes } from "./backfill.js";
import { insightRoutes } from "./insights.js";
import { knowledgeRoutes } from "./knowledge.js";
import { projectRoutes } from "./projects.js";
import { reportRoutes } from "./reports.js";
import type { Route } from "./router.js";
import { sessionRoutes } from "./sessions.js";
import { systemRoutes } from "./system.js";

export { Router, type Route, type RouteContext, type RouteServices } from "./router.js";

/** Every REST route, one table per domain. */
export const apiRoutes: readonly Route[] = [
  ...systemRoutes,
  ...reportRoutes,
  ...projectRoutes,
  ...knowledgeRoutes,
  ...insightRoutes,
  ...sessionRoutes,
  ...backfillRoutes,
];
