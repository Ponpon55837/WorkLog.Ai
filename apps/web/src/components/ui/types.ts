import type { Component } from "vue";

/** A lucide-vue-next icon component (or any component rendering an inline SVG icon). */
export type IconComponent = Component;

export type Tone = "neutral" | "accent" | "success" | "attention" | "danger" | "done";

export type SelectOption<T extends string | number = string> = {
  value: T;
  label: string;
  icon?: IconComponent;
  tone?: Tone;
  description?: string;
  count?: number;
};

/** Shared lucide props so every icon is 16px with a 1.75 stroke. */
export const iconProps = { size: 16, "stroke-width": 1.75 } as const;

export type DateRange = { from: string; to: string };
