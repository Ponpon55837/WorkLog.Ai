export function useClipboard(): {
  copyText: (value: string) => Promise<void>;
} {
  async function copyText(value: string): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error("目前瀏覽器不允許使用剪貼簿 API，請手動複製文字。");
    }
    await navigator.clipboard.writeText(value);
  }

  return { copyText };
}
