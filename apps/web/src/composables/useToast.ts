import { storeToRefs } from "pinia";
import { useToastsStore, type ToastTone } from "../stores/toasts";
import { useClipboard } from "./useClipboard";
import { t } from "../i18n";

export type { Toast, ToastTone } from "../stores/toasts";

async function copyWithToast(text: string, successMessage: string): Promise<boolean> {
  const { showToast } = useToastsStore();
  try {
    await useClipboard().copyText(text);
    showToast(successMessage, "success");
    return true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : t("ui.clipboardIsUnavailableCopyThe"), "danger");
    return false;
  }
}

export function useToast() {
  const store = useToastsStore();
  const { toasts } = storeToRefs(store);
  return {
    toasts,
    showToast: (message: string, tone: ToastTone = "default") => store.showToast(message, tone),
    dismissToast: store.dismissToast,
    copyWithToast,
  };
}
