<script setup lang="ts" generic="T extends string | number">
import { computed, nextTick, watch } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";
import { usePopover } from "../../composables/usePopover";
import type { IconComponent, SelectOption } from "./types";

/**
 * Dropdown menu. With `v-model` it is a single-select filter (check marks, "applied" trigger state);
 * without it, items are actions and `select` is emitted.
 */
const props = withDefaults(
  defineProps<{
    label: string;
    items: readonly SelectOption<T>[];
    header?: string;
    icon?: IconComponent;
    align?: "start" | "end";
    /** Value that means "no filter"; when the model differs the trigger shows as applied. */
    defaultValue?: T;
    variant?: "filter" | "button";
    size?: "md" | "sm";
    hideLabelOnMobile?: boolean;
  }>(),
  { align: "start", variant: "filter", size: "md" },
);

const model = defineModel<T>();
const emit = defineEmits<{ select: [value: T] }>();

const { open, trigger, panel, style, toggle, close } = usePopover({ align: computed(() => props.align), width: 260 });
const applied = computed(
  () => model.value !== undefined && props.defaultValue !== undefined && model.value !== props.defaultValue,
);

function choose(value: T): void {
  if (model.value !== undefined || props.defaultValue !== undefined) {
    model.value = value;
  }
  emit("select", value);
  close();
  trigger.value?.focus();
}

function itemButtons(): HTMLButtonElement[] {
  return Array.from(
    panel.value?.querySelectorAll<HTMLButtonElement>("button[role='menuitemradio'], button[role='menuitem']") ?? [],
  );
}

function moveFocus(event: KeyboardEvent): void {
  const buttons = itemButtons();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    buttons[(index + 1) % buttons.length]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
  } else if (event.key === "Tab") {
    close();
  }
}

watch(open, async (value) => {
  if (value) {
    await nextTick();
    const buttons = itemButtons();
    (buttons.find((button) => button.getAttribute("aria-checked") === "true") ?? buttons[0])?.focus();
  }
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    :class="[
      'ui-action-menu__trigger',
      `ui-action-menu__trigger--${variant}`,
      `ui-action-menu__trigger--${size}`,
      { 'is-applied': applied, 'is-open': open },
    ]"
    aria-haspopup="menu"
    :aria-expanded="open"
    @click="toggle"
  >
    <component :is="icon" v-if="icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
    <span :class="{ 'ui-action-menu__label--hide-sm': hideLabelOnMobile }">{{ label }}</span>
    <ChevronDown :size="14" :stroke-width="1.75" aria-hidden="true" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="ui-action-menu__panel"
      :style="style"
      role="menu"
      :aria-label="header ?? label"
      @keydown="moveFocus"
    >
      <div v-if="header" class="ui-action-menu__header">{{ header }}</div>
      <button
        v-for="item in items"
        :key="String(item.value)"
        type="button"
        :role="model !== undefined ? 'menuitemradio' : 'menuitem'"
        :aria-checked="model !== undefined ? model === item.value : undefined"
        class="ui-action-menu__item"
        @click="choose(item.value)"
      >
        <span v-if="model !== undefined" class="ui-action-menu__check">
          <Check v-if="model === item.value" :size="16" :stroke-width="2" aria-hidden="true" />
        </span>
        <component
          :is="item.icon"
          v-if="item.icon"
          :size="16"
          :stroke-width="1.75"
          :class="['ui-action-menu__item-icon', item.tone && `tone-${item.tone}`]"
          aria-hidden="true"
        />
        <span class="ui-action-menu__item-copy">
          <span>{{ item.label }}</span>
          <small v-if="item.description">{{ item.description }}</small>
        </span>
        <span v-if="item.count !== undefined" class="ui-action-menu__count">{{ item.count }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-action-menu__trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--control-height-sm);
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: var(--fg-muted);
  font-size: var(--text-md);
  white-space: nowrap;
}

.ui-action-menu__trigger:hover,
.ui-action-menu__trigger.is-open {
  background: var(--bg-hover);
  color: var(--fg);
}

.ui-action-menu__trigger.is-applied {
  color: var(--fg);
  font-weight: 600;
}

.ui-action-menu__trigger--button {
  height: var(--control-height);
  padding: 0 var(--space-3);
  border-color: var(--border);
  background: var(--bg-muted);
  color: var(--fg);
  font-weight: 500;
}

.ui-action-menu__trigger--button.ui-action-menu__trigger--sm {
  height: var(--control-height-sm);
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
}

.ui-action-menu__trigger--button:hover,
.ui-action-menu__trigger--button.is-open {
  border-color: var(--border-strong);
  background: var(--bg-muted-hover);
}

.ui-action-menu__trigger :deep(.lucide) {
  color: var(--fg-muted);
}

.ui-action-menu__panel {
  position: fixed;
  z-index: 60;
  max-height: min(420px, 70vh);
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  box-shadow: var(--shadow-popover);
}

.ui-action-menu__header {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg);
  font-size: var(--text-xs);
  font-weight: 600;
}

.ui-action-menu__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-top: 1px solid var(--border-muted);
  background: none;
  color: var(--fg);
  font-size: var(--text-sm);
  text-align: left;
}

.ui-action-menu__header + .ui-action-menu__item,
.ui-action-menu__item:first-child {
  border-top: 0;
}

.ui-action-menu__item:hover,
.ui-action-menu__item:focus-visible {
  outline: none;
  background: var(--bg-hover);
}

.ui-action-menu__check {
  display: inline-flex;
  width: 16px;
  color: var(--accent);
}

.ui-action-menu__item-icon {
  color: var(--fg-muted);
}

.ui-action-menu__item-copy {
  display: grid;
  flex: 1;
  min-width: 0;
}

.ui-action-menu__item-copy small {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.ui-action-menu__count {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.tone-success {
  color: var(--success);
}
.tone-danger {
  color: var(--danger);
}
.tone-attention {
  color: var(--attention);
}
.tone-accent {
  color: var(--accent);
}
.tone-done {
  color: var(--done);
}

@media (max-width: 639px) {
  .ui-action-menu__label--hide-sm {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
}
</style>
