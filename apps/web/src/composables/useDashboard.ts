import { storeToRefs } from "pinia";
import { useDashboardStore } from "../stores/dashboard";

export type { InboxItem } from "../stores/dashboard";

/** Transitional adapter exposing the dashboard store to existing view consumers. */
export function useDashboard() {
  const store = useDashboardStore();
  const { weekReport, weekVerification, inbox, dashboardLoading } = storeToRefs(store);
  return { weekReport, weekVerification, inbox, dashboardLoading, loadDashboardData: store.loadDashboardData };
}
