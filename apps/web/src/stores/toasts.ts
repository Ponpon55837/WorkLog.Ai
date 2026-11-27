import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastTone = "default" | "success" | "danger";
export type ToastAction = { label: string; run: () => void | Promise<void> };
/** @internal test-only */
export type Toast = { id: number; message: string; tone: ToastTone; action?: ToastAction };

const TIMEOUT_MS = 4_000;
const ACTION_TIMEOUT_MS = 8_000;
const MAX_TOASTS = 4;

export const useToastsStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  function showToast(message: string, tone: ToastTone = "default", action?: ToastAction): void {
    const id = nextId++;
    toasts.value = [...toasts.value, { id, message, tone, action }].slice(-MAX_TOASTS);
    window.setTimeout(() => dismissToast(id), action ? ACTION_TIMEOUT_MS : TIMEOUT_MS);
  }

  async function runToastAction(id: number): Promise<void> {
    const action = toasts.value.find((toast) => toast.id === id)?.action;
    dismissToast(id);
    await action?.run();
  }

  function $reset(): void {
    toasts.value = [];
  }

  return { toasts, showToast, dismissToast, runToastAction, $reset };
});
