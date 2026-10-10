import { reportPresentationRoutes } from "./report-presentation.js";
import { attentionRoutes } from "./attention.js";
import { agentReadRoutes } from "./agent-reads.js";
import { backfillRoutes } from "./backfill.js";
import { insightRoutes } from "./insights.js";
import { outstandingCleanupRoutes } from "./outstanding-cleanup.js";
import { outstandingItemRoutes } from "./outstanding-items.js";
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
  ...attentionRoutes,
  ...reportPresentationRoutes,
  ...reportRoutes,
  ...projectRoutes,
  ...knowledgeRoutes,
  ...insightRoutes,
  ...sessionRoutes,
  ...agentReadRoutes,
  ...outstandingItemRoutes,
  ...outstandingCleanupRoutes,
  ...backfillRoutes,
];
