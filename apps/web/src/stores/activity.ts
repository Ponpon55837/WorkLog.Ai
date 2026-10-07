import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { ActivityDay, ActivityQuery, ActivityResult } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { activityRange } from "../utils/activity-calendar";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

/** Owns the dashboard's work-activity heatmap: Sessions completed per local day over the last year. */
export const useActivityStore = defineStore("activity", () => {
  const enabled = ref(false);

  function scope(): ActivityQuery {
    return activityRange(new Date());
  }

  const query = useQuery<ActivityResult>({
    key: () => [...queryKeys.dashboard.activity, scope()],
    enabled,
    query: ({ signal }) => useApi().client.getActivity(scope(), signal),
  });

  const days = computed<ActivityDay[]>(() => (query.data.value?.outcome === "activity" ? query.data.value.days : []));
  /** False until the first answer, so the view shows a skeleton rather than a zero. */
  const activityLoaded = computed(() => query.data.value !== undefined);
  const activityError = computed(() =>
    query.error.value ? errorMessage(query.error.value, t("dashboard.couldNotLoadActivity")) : "",
  );

  function setActive(active: boolean): void {
    enabled.value = active;
  }

  async function reloadActivity(): Promise<void> {
    await query.refetch();
  }

  return { days, activityLoaded, activityError, setActive, reloadActivity };
});
