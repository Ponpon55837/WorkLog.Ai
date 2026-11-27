import type { Component } from "vue";

export type IconComponent = Component;

export type Tone = "neutral" | "accent" | "success" | "attention" | "danger" | "done";

export type ChartTone = Tone | "diagram-5" | "diagram-6";

export type SelectOption<T extends string | number = string> = {
  value: T;
  label: string;
  icon?: IconComponent;
  tone?: Tone;
  description?: string;
  count?: number;
};

export const iconProps = { size: 16, "stroke-width": 1.75 } as const;

export type DateRange = { from: string; to: string };
