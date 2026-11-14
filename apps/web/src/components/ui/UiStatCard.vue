<script setup lang="ts">
import type { IconComponent, Tone } from "./types";

defineProps<{
  label: string;
  value: string | number;
  icon?: IconComponent;
  /** Secondary value after the main number, e.g. "showcase.passedOf24". */
  suffix?: string;
  foot?: string;
  valueTone?: Tone;
  delta?: { direction: "up" | "down" | "flat"; text: string };
  /** Tighter padding and a smaller value, for cards inside a dialog or a preview. */
  compact?: boolean;
  /** Chart card: label, value and foot on the left, the default slot (a `UiSparkline size="lg"`) on the right. */
  featured?: boolean;
}>();
</script>

<template>
  <article :class="['ui-stat', { 'ui-stat--compact': compact, 'ui-stat--featured': featured }]">
    <div class="ui-stat__label">
      <component :is="icon" v-if="icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
      {{ label }}
    </div>
    <div :class="['ui-stat__value', valueTone && `tone-${valueTone}`]">
      {{ value }}
      <span v-if="suffix" class="ui-stat__suffix">{{ suffix }}</span>
      <span v-if="delta" :class="['ui-stat__delta', `ui-stat__delta--${delta.direction}`]">
        {{ delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "—" }} {{ delta.text }}
      </span>
    </div>
    <slot />
    <div v-if="foot || $slots.foot" class="ui-stat__foot">
      <slot name="foot">{{ foot }}</slot>
    </div>
  </article>
</template>

<style scoped>
/* Cards rise in one after another (at most 5 steps of delay). */
.ui-stat {
  animation: wi-fade-up var(--duration-slow) var(--ease-out) both;
}

.ui-stat:nth-child(2) {
  animation-delay: 40ms;
}

.ui-stat:nth-child(3) {
  animation-delay: 80ms;
}

.ui-stat:nth-child(4) {
  animation-delay: 120ms;
}

.ui-stat:nth-child(n + 5) {
  animation-delay: 160ms;
}

.ui-stat {
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-outer);
  background: var(--bg-surface);
}

.ui-stat--compact {
  padding: var(--space-3);
}

.ui-stat--compact .ui-stat__value {
  margin-top: var(--space-1);
  font-size: var(--text-lg);
}

.ui-stat__label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.ui-stat__value {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  margin-top: var(--space-1);
  color: var(--fg);
  font-size: var(--text-2xl);
  font-weight: 600;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

.ui-stat__suffix {
  color: var(--fg-muted);
  font-size: var(--text-sm);
  font-weight: 400;
}

.ui-stat__delta {
  font-size: var(--text-xs);
  font-weight: 500;
}

.ui-stat__delta--up {
  color: var(--success);
}
.ui-stat__delta--down {
  color: var(--danger);
}
.ui-stat__delta--flat {
  color: var(--fg-muted);
}

.ui-stat__foot {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

/* Chart card: text on the left, the slotted chart bottom-aligned on the right. */
.ui-stat--featured {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(88px, 220px);
  column-gap: var(--space-4);
  align-items: end;
}

.ui-stat--featured > .ui-stat__label,
.ui-stat--featured > .ui-stat__value,
.ui-stat--featured > .ui-stat__foot {
  grid-column: 1;
}

.ui-stat--featured > :slotted(*) {
  grid-column: 2;
  grid-row: 1 / span 3;
  margin-top: 0;
}

.tone-attention {
  color: var(--attention);
}
.tone-danger {
  color: var(--danger);
}
.tone-success {
  color: var(--success);
}
</style>
