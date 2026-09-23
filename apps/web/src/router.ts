import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

export type NavGroup = "work" | "knowledge" | "manage";

declare module "vue-router" {
  interface RouteMeta {
    title?: string;
    eyebrow?: string;
    group?: NavGroup;
    navLabel?: string;
  }
}

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/dashboard" },
  {
    path: "/dashboard",
    name: "dashboard",
    component: () => import("./views/DashboardView.vue"),
    meta: { title: "工作總覽", navLabel: "總覽", eyebrow: "TODAY'S SIGNAL", group: "work" }
  },
  {
    path: "/sessions",
    name: "sessions",
    component: () => import("./views/SessionsView.vue"),
    meta: { title: "工作歷程", navLabel: "工作歷程", eyebrow: "SESSION ARCHIVE", group: "work" }
  },
  { path: "/worklog", redirect: (to) => ({ path: "/sessions", query: to.query }) },
  {
    path: "/reports/:tab?",
    name: "reports",
    component: () => import("./views/ReportsView.vue"),
    meta: { title: "工作報告", navLabel: "工作報告", eyebrow: "WORK REPORTS", group: "work" }
  },
  {
    path: "/knowledge",
    name: "knowledge",
    component: () => import("./views/KnowledgeView.vue"),
    meta: { title: "工作知識", navLabel: "工作知識", eyebrow: "EXPLICIT KNOWLEDGE", group: "knowledge" }
  },
  {
    path: "/graph",
    name: "graph",
    component: () => import("./views/GraphView.vue"),
    meta: { title: "工作圖譜", navLabel: "工作圖譜", eyebrow: "DETERMINISTIC WORK GRAPH", group: "knowledge" }
  },
  {
    path: "/projects/:tab?",
    name: "projects",
    component: () => import("./views/ProjectsView.vue"),
    meta: { title: "專案", navLabel: "專案", eyebrow: "PROJECT REGISTRY", group: "manage" }
  },
  { path: "/:pathMatch(.*)*", redirect: "/dashboard" }
];

if (import.meta.env.DEV) {
  routes.unshift({
    path: "/__ui",
    name: "ui-showcase",
    component: () => import("./views/UiShowcaseView.vue"),
    meta: { title: "UI 元件展示", eyebrow: "DESIGN SYSTEM" }
  });
}

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
});
