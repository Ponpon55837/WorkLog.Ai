import { ref } from "vue";
import { useClipboard } from "./useClipboard";

export type ToastTone = "default" | "success" | "danger";
export type Toast = { id: number; message: string; tone: ToastTone };

const toasts = ref<Toast[]>([]);
const timeoutMs = 4_000;
const maxToasts = 4;
let nextId = 1;

function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

function showToast(message: string, tone: ToastTone = "default"): void {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, message, tone }].slice(-maxToasts);
  window.setTimeout(() => dismissToast(id), timeoutMs);
}

async function copyWithToast(text: string, successMessage: string): Promise<void> {
  try {
    await useClipboard().copyText(text);
    showToast(successMessage, "success");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "無法使用剪貼簿，請手動複製文字。", "danger");
  }
}

export function useToast() {
  return { toasts, showToast, dismissToast, copyWithToast };
}
