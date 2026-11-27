import { storeToRefs } from "pinia";
import { useToastsStore, type ToastAction, type ToastTone } from "../stores/toasts";
import { useClipboard } from "./useClipboard";
import { t } from "../i18n";

/** @internal test-only */
export type { Toast, ToastAction, ToastTone } from "../stores/toasts";

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
    showToast: (message: string, tone: ToastTone = "default", action?: ToastAction) =>
      store.showToast(message, tone, action),
    dismissToast: store.dismissToast,
    holdToast: store.holdToast,
    releaseToast: store.releaseToast,
    runToastAction: store.runToastAction,
    copyWithToast,
  };
}
