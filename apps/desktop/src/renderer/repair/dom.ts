// Small DOM helpers shared by the App window's views (Status, Data, Settings, Diagnostics, first run, Agents). Text is
// always set as text, never as HTML: everything the page shows comes from main, and none of it is markup.

export type ButtonVariant = "default" | "primary" | "danger" | "link";

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string } = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  node.append(...children);
  return node;
}

/** A card (UiBox): a header row with the title, then a padded body. `title` may carry a label pill beside the text. */
export function section(title: string | readonly (Node | string)[], ...content: Node[]): HTMLElement {
  const heading = element(
    "h2",
    typeof title === "string" ? { text: title } : {},
    typeof title === "string" ? [] : title,
  );
  return element("section", { className: "card" }, [
    element("header", { className: "card-head" }, [heading]),
    element("div", { className: "card-body" }, content),
  ]);
}

/** The body of a card made by `section`, where more content goes. */
export function cardBody(card: HTMLElement): HTMLElement {
  return card.querySelector<HTMLElement>(":scope > .card-body") ?? card;
}

export function fact(label: string, value: Node | string): [HTMLElement, HTMLElement] {
  return [element("dt", { text: label }), element("dd", {}, [value])];
}

/** A button; `enabled` also covers "another action is running", which the caller passes in. `true` means primary. */
export function button(
  label: string,
  id: string,
  enabled: boolean,
  onClick: () => void,
  variant: boolean | ButtonVariant = "default",
): HTMLButtonElement {
  const kind = variant === true ? "primary" : variant === false ? "default" : variant;
  const node = element("button", { text: label, className: `btn btn--${kind}` });
  node.type = "button";
  node.dataset.id = id;
  node.disabled = !enabled;
  node.addEventListener("click", onClick);
  return node;
}

export function checkbox(label: string, id: string, checked: boolean, enabled: boolean): HTMLLabelElement {
  const input = element("input", { className: "checkbox" });
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = !enabled;
  input.dataset.id = id;
  return element("label", { className: "check" }, [input, element("span", { text: label })]);
}

export function isChecked(root: ParentNode, id: string): boolean {
  return root.querySelector<HTMLInputElement>(`input[data-id="${CSS.escape(id)}"]`)?.checked === true;
}

/** Keeps keyboard focus on the same control across a re-render. */
export function focusedId(): string | undefined {
  return document.activeElement instanceof HTMLElement ? document.activeElement.dataset.id : undefined;
}

export function restoreFocus(root: ParentNode, id: string | undefined): void {
  if (id) root.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
}

/** The page language only; the window title belongs to the page shell, which does not change with the tab. */
export function setLanguage(locale: string): void {
  document.documentElement.lang = locale === "zh-TW" ? "zh-Hant" : "en";
}
