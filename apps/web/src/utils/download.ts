/** Downloads a prepared text snapshot with no additional server request. */
export function downloadText(content: string, filename: string, contentType = "text/markdown; charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
