import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastTone = "default" | "success" | "danger";
export type Toast = { id: number; message: string; tone: ToastTone };

const TIMEOUT_MS = 4_000;
const MAX_TOASTS = 4;

/** Short notices shown by UiToastHost; each disappears after a few seconds, and only the newest few stay. */
export const useToastsStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  function showToast(message: string, tone: ToastTone = "default"): void {
    const id = nextId++;
    toasts.value = [...toasts.value, { id, message, tone }].slice(-MAX_TOASTS);
    window.setTimeout(() => dismissToast(id), TIMEOUT_MS);
  }

  function $reset(): void {
    toasts.value = [];
  }

  return { toasts, showToast, dismissToast, $reset };
});
