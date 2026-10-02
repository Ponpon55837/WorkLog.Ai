import { t } from "../i18n";
export function useClipboard(): {
  copyText: (value: string) => Promise<void>;
} {
  async function copyText(value: string): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error(t("ui.thisBrowserDoesNotAllow"));
    }
    await navigator.clipboard.writeText(value);
  }

  return { copyText };
}
