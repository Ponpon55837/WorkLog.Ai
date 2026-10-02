import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import type { MessageKey } from "./i18n";

export type NavGroup = "work" | "knowledge" | "manage";

declare module "vue-router" {
  /** title and navLabel are message keys (src/i18n/locales); display sites translate them with t(). */
  interface RouteMeta {
    title?: MessageKey;
    eyebrow?: string;
    group?: NavGroup;
    navLabel?: MessageKey;
  }
}

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/dashboard" },
  {
    path: "/dashboard",
    name: "dashboard",
    component: () => import("./views/DashboardView.vue"),
    meta: { title: "nav.workOverview", navLabel: "common.overview", eyebrow: "TODAY'S SIGNAL", group: "work" },
  },
  {
    path: "/sessions/:tab?",
    name: "sessions",
    component: () => import("./views/SessionsView.vue"),
    meta: { title: "common.workHistory", navLabel: "common.workHistory", eyebrow: "SESSION ARCHIVE", group: "work" },
  },
  { path: "/worklog", redirect: (to) => ({ path: "/sessions", query: to.query }) },
  {
    path: "/reports/:tab?",
    name: "reports",
    component: () => import("./views/ReportsView.vue"),
    meta: { title: "nav.workReports", navLabel: "nav.workReports", eyebrow: "WORK REPORTS", group: "work" },
  },
  {
    path: "/knowledge/:tab?",
    name: "knowledge",
    component: () => import("./views/KnowledgeView.vue"),
    meta: {
      title: "common.workKnowledge",
      navLabel: "common.workKnowledge",
      eyebrow: "EXPLICIT KNOWLEDGE",
      group: "knowledge",
    },
  },
  {
    path: "/graph/:tab?",
    name: "graph",
    component: () => import("./views/GraphView.vue"),
    meta: {
      title: "nav.workGraph",
      navLabel: "nav.workGraph",
      eyebrow: "DETERMINISTIC WORK GRAPH",
      group: "knowledge",
    },
  },
  {
    path: "/projects/:tab?",
    name: "projects",
    component: () => import("./views/ProjectsView.vue"),
    meta: { title: "nav.projects", navLabel: "nav.projects", eyebrow: "PROJECT REGISTRY", group: "manage" },
  },
  {
    path: "/system-status",
    name: "system-status",
    component: () => import("./views/SystemStatusView.vue"),
    meta: { title: "nav.systemStatus", navLabel: "nav.systemStatus", eyebrow: "SYSTEM STATUS", group: "manage" },
  },
  { path: "/:pathMatch(.*)*", redirect: "/dashboard" },
];

if (import.meta.env.DEV) {
  routes.unshift({
    path: "/__ui",
    name: "ui-showcase",
    component: () => import("./views/UiShowcaseView.vue"),
    meta: { title: "common.uiComponentShowcase", eyebrow: "DESIGN SYSTEM" },
  });
}

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
