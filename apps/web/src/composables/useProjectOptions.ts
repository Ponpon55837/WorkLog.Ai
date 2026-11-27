import { computed, type ComputedRef } from "vue";
import { storeToRefs } from "pinia";
import { useProjectsStore } from "../stores/projects";
import type { SelectOption } from "../components/ui/types";
import { t } from "../i18n";

type ProjectOptionsInput = {
  allLabel?: () => string | null;
  scope?: () => "tracked" | "all";
};

/** Project choices from the projects store, so a selected project never narrows what else can be picked. */
export function useProjectOptions(input: ProjectOptionsInput = {}): ComputedRef<SelectOption<string>[]> {
  const { projects, trackedProjects } = storeToRefs(useProjectsStore());
  return computed(() => {
    const everyProject = input.scope?.() === "all";
    const defaultAllLabel = t(everyProject ? "common.allProjects" : "common.allTrackedProjects");
    const allLabel = input.allLabel ? input.allLabel() : defaultAllLabel;
    const source = everyProject ? projects.value : trackedProjects.value;
    const items = source.map((project) => ({ value: project.id, label: project.name }));
    return allLabel === null ? items : [{ value: "", label: allLabel }, ...items];
  });
}
