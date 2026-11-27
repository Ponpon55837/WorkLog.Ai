<script setup lang="ts">
import { computed } from "vue";
import type { IconComponent } from "../ui/types";
import UiActionMenu from "../ui/UiActionMenu.vue";
import { useProjectOptions } from "../../composables/useProjectOptions";
import { t } from "../../i18n";

/** Project picker fed by the projects store, so the chosen project never narrows what else is listed. */
const props = withDefaults(
  defineProps<{
    label?: string;
    header?: string;
    icon?: IconComponent;
    align?: "start" | "end";
    variant?: "filter" | "button";
    size?: "md" | "sm";
    includeAll?: boolean;
    allLabel?: string;
    scope?: "tracked" | "all";
  }>(),
  { includeAll: true, scope: "tracked" },
);

const emit = defineEmits<{ select: [value: string] }>();
const model = defineModel<string>();

const items = useProjectOptions({
  allLabel: () =>
    props.includeAll
      ? (props.allLabel ?? t(props.scope === "all" ? "common.allProjects" : "common.allTrackedProjects"))
      : null,
  scope: () => props.scope,
});
const menuLabel = computed(() => props.label ?? t("common.project"));
</script>

<template>
  <UiActionMenu
    v-model="model"
    :label="menuLabel"
    :header="header"
    :icon="icon"
    :align="align"
    :variant="variant"
    :size="size"
    :items="items"
    :default-value="includeAll ? '' : undefined"
    @select="emit('select', $event)"
  />
</template>
