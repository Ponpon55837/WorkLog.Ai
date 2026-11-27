import { element } from "./dom.js";

export interface ModalOptions {
  readonly title: string;
  readonly headingId: string;
  readonly className?: string;
  readonly body: readonly Node[];
  readonly footer: readonly Node[];
  readonly returnFocus: () => void;
  readonly initialFocus?: () => HTMLElement | null;
  readonly canClose?: () => boolean;
}

/** @internal test-only */
export interface Modal {
  readonly dialog: HTMLDialogElement;
  close(): void;
}

function overlayRoot(): HTMLElement {
  return document.getElementById("overlay") ?? document.body;
}

export function openModal(options: ModalOptions): Modal {
  const canClose = options.canClose ?? ((): boolean => true);
  const dialog = element("dialog", { className: `dialog ${options.className ?? ""}`.trim() }, [
    element("header", { className: "dialog-head" }, [
      Object.assign(element("h2", { text: options.title }), { id: options.headingId }),
    ]),
    element("div", { className: "dialog-body" }, options.body),
    element("footer", { className: "dialog-foot" }, options.footer),
  ]);
  dialog.setAttribute("aria-labelledby", options.headingId);
  dialog.addEventListener("cancel", (event) => {
    if (!canClose()) event.preventDefault();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && canClose()) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    options.returnFocus();
  });
  overlayRoot().append(dialog);
  dialog.showModal();
  options.initialFocus?.()?.focus();
  return { dialog, close: () => dialog.close() };
}
