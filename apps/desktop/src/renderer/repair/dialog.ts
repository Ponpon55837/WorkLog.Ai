import { element } from "./dom.js";

/**
 * The shared modal (UiDialog): a native modal dialog, so the page behind it is inert, focus stays inside it and Esc
 * closes it. It is attached to the overlay root, never to a tab panel, so a tab change or a redraw of the panel does not
 * touch it. When it closes, `returnFocus` puts focus back on the control that opened it: the page decides where that is,
 * because the control is redrawn (and the tab may have changed) while the dialog is open.
 */
export interface ModalOptions {
  readonly title: string;
  readonly headingId: string;
  readonly className?: string;
  readonly body: readonly Node[];
  readonly footer: readonly Node[];
  /** Puts focus back on the control that opened the modal (or, when it is gone, on the open tab). */
  readonly returnFocus: () => void;
  /** The control that gets focus when the modal opens. */
  readonly initialFocus?: () => HTMLElement | null;
  /** Esc and a click on the backdrop close the modal only while this says so (not while a save is running). */
  readonly canClose?: () => boolean;
}

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
