import { Activity, BookOpen, ChartColumn, FolderGit2, LayoutDashboard, ListChecks, Share2 } from "lucide-vue-next";
import type { NavGroup } from "../../router";
import type { IconComponent } from "../ui/types";
import { translatedOptions } from "../../i18n";

export type NavItem = { name: string; label: string; icon: IconComponent; group: NavGroup; shortcut: string };

/** Sidebar order and icons. Titles and eyebrows live in route meta (router.ts). */
export const navItems: readonly NavItem[] = translatedOptions<NavItem, "label">(
  [
    { name: "dashboard", label: "common.overview", icon: LayoutDashboard, group: "work", shortcut: "g d" },
    { name: "sessions", label: "common.workHistory", icon: ListChecks, group: "work", shortcut: "g s" },
    { name: "reports", label: "nav.workReports", icon: ChartColumn, group: "work", shortcut: "g r" },
    { name: "knowledge", label: "common.workKnowledge", icon: BookOpen, group: "knowledge", shortcut: "g k" },
    { name: "graph", label: "nav.workGraph", icon: Share2, group: "knowledge", shortcut: "g g" },
    { name: "projects", label: "nav.projects", icon: FolderGit2, group: "manage", shortcut: "g p" },
    { name: "system-status", label: "nav.systemStatus", icon: Activity, group: "manage", shortcut: "g y" },
  ],
  "label",
);

export const navGroups: readonly { id: NavGroup; label: string }[] = [
  { id: "work", label: "Work" },
  { id: "knowledge", label: "Knowledge" },
  { id: "manage", label: "Manage" },
];
