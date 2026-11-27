import {
  Activity,
  BookOpen,
  ChartColumn,
  FolderGit2,
  Gauge,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  Share2,
} from "lucide-vue-next";
import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from "vue-router";
import type { NavGroup } from "../../router";
import type { IconComponent } from "../ui/types";
import { translatedOptions } from "../../i18n";

export type NavItem = { name: string; label: string; icon: IconComponent; group: NavGroup; shortcut: string };

export const navItems: readonly NavItem[] = translatedOptions<NavItem, "label">(
  [
    { name: "dashboard", label: "common.overview", icon: LayoutDashboard, group: "work", shortcut: "g d" },
    { name: "sessions", label: "common.workHistory", icon: ListChecks, group: "work", shortcut: "g s" },
    { name: "outstanding", label: "common.openItems", icon: ListTodo, group: "work", shortcut: "g o" },
    { name: "reports", label: "nav.workReports", icon: ChartColumn, group: "work", shortcut: "g r" },
    { name: "knowledge", label: "common.workKnowledge", icon: BookOpen, group: "knowledge", shortcut: "g k" },
    { name: "graph", label: "nav.workGraph", icon: Share2, group: "knowledge", shortcut: "g g" },
    { name: "projects", label: "nav.projects", icon: FolderGit2, group: "manage", shortcut: "g p" },
    { name: "usage", label: "nav.usage", icon: Gauge, group: "manage", shortcut: "g u" },
    { name: "system-status", label: "nav.systemStatus", icon: Activity, group: "manage", shortcut: "g y" },
  ],
  "label",
);

export function navTarget(item: NavItem): RouteLocationRaw {
  return item.name === "outstanding" ? { name: "sessions", params: { tab: "outstanding" } } : { name: item.name };
}

export function isNavItemActive(item: NavItem, route: RouteLocationNormalizedLoaded): boolean {
  const onOutstanding = route.name === "sessions" && route.params.tab === "outstanding";
  if (item.name === "outstanding") return onOutstanding;
  if (item.name === "sessions") return route.name === "sessions" && !onOutstanding;
  return route.name === item.name;
}

export const navGroups: readonly { id: NavGroup; label: string }[] = translatedOptions<
  { id: NavGroup; label: string },
  "label"
>(
  [
    { id: "work", label: "nav.groupWork" },
    { id: "knowledge", label: "nav.groupKnowledge" },
    { id: "manage", label: "nav.groupManage" },
  ],
  "label",
);
