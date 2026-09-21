import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import DashboardView from "./views/DashboardView.vue";
import GraphView from "./views/GraphView.vue";
import KnowledgeView from "./views/KnowledgeView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ReportsView from "./views/ReportsView.vue";
import WorklogView from "./views/WorklogView.vue";

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/dashboard" },
  { path: "/dashboard", name: "dashboard", component: DashboardView, meta: { view: "dashboard" } },
  { path: "/projects", name: "projects", component: ProjectsView, meta: { view: "projects" } },
  { path: "/reports", name: "reports", component: ReportsView, meta: { view: "reports" } },
  { path: "/knowledge", name: "knowledge", component: KnowledgeView, meta: { view: "knowledge" } },
  { path: "/graph", name: "graph", component: GraphView, meta: { view: "graph" } },
  { path: "/worklog", name: "worklog", component: WorklogView, meta: { view: "worklog" } }
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
});
