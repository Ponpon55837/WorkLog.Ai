import { ref } from "vue";
import { useClipboard } from "./useClipboard";

const toastMessage = ref("");

export function useToast(): {
  toastMessage: typeof toastMessage;
  showToast: (message: string) => void;
  dismissToast: () => void;
  copyWithToast: (text: string, successMessage: string) => Promise<void>;
} {
  function showToast(message: string): void {
    toastMessage.value = message;
  }

  function dismissToast(): void {
    toastMessage.value = "";
  }

  async function copyWithToast(text: string, successMessage: string): Promise<void> {
    try {
      await useClipboard().copyText(text);
      showToast(successMessage);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "無法使用剪貼簿，請手動複製文字。");
    }
  }

  return { toastMessage, showToast, dismissToast, copyWithToast };
}
