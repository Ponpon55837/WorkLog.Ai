import { Activity, BookOpen, ChartColumn, FolderGit2, LayoutDashboard, ListChecks, Share2 } from "lucide-vue-next";
import type { NavGroup } from "../../router";
import type { IconComponent } from "../ui/types";

export type NavItem = { name: string; label: string; icon: IconComponent; group: NavGroup; shortcut: string };

/** Sidebar order and icons. Titles and eyebrows live in route meta (router.ts). */
export const navItems: readonly NavItem[] = [
  { name: "dashboard", label: "總覽", icon: LayoutDashboard, group: "work", shortcut: "g d" },
  { name: "sessions", label: "工作歷程", icon: ListChecks, group: "work", shortcut: "g s" },
  { name: "reports", label: "工作報告", icon: ChartColumn, group: "work", shortcut: "g r" },
  { name: "knowledge", label: "工作知識", icon: BookOpen, group: "knowledge", shortcut: "g k" },
  { name: "graph", label: "工作圖譜", icon: Share2, group: "knowledge", shortcut: "g g" },
  { name: "projects", label: "專案", icon: FolderGit2, group: "manage", shortcut: "g p" },
  { name: "system-status", label: "系統狀態", icon: Activity, group: "manage", shortcut: "g y" },
];

export const navGroups: readonly { id: NavGroup; label: string }[] = [
  { id: "work", label: "Work" },
  { id: "knowledge", label: "Knowledge" },
  { id: "manage", label: "Manage" },
];
