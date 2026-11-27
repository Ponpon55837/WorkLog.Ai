import { computed, type ComputedRef, type Ref } from "vue";
import { storeToRefs } from "pinia";
import type { FilterChip } from "../components/ui/types";
import { useProjectsStore } from "../stores/projects";
import { filterChip } from "../utils/filter-chips";
import { t } from "../i18n";

/** The chip of a selected project, or `undefined` while none is selected; a project the store no longer lists keeps its id. */
export function useProjectChip(projectId: Ref<string>): ComputedRef<FilterChip | undefined> {
  const { projects } = storeToRefs(useProjectsStore());
  return computed(() => {
    if (!projectId.value) return undefined;
    const name = projects.value.find((project) => project.id === projectId.value)?.name ?? projectId.value;
    return filterChip("project", t("common.project"), name);
  });
}
