/** Downloads a prepared text snapshot with no additional server request. */
export function downloadText(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown; charset=utf-8" }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
