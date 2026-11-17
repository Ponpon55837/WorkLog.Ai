// Small DOM helpers shared by the App window's views (repair, first run, Agents). Text is always set as text, never as
// HTML: everything the page shows comes from main, and none of it is markup.

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

export function section(title: string, ...content: Node[]): HTMLElement {
  return element("section", { className: "card" }, [element("h2", { text: title }), ...content]);
}

export function fact(label: string, value: Node | string): [HTMLElement, HTMLElement] {
  return [element("dt", { text: label }), element("dd", {}, [value])];
}

/** A button; `disabled` also covers "another action is running", which the caller passes in. */
export function button(
  label: string,
  id: string,
  enabled: boolean,
  onClick: () => void,
  primary = false,
): HTMLButtonElement {
  const node = element("button", { text: label, className: primary ? "primary" : "" });
  node.type = "button";
  node.dataset.id = id;
  node.disabled = !enabled;
  node.addEventListener("click", onClick);
  return node;
}

export function checkbox(label: string, id: string, checked: boolean, enabled: boolean): HTMLLabelElement {
  const input = element("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = !enabled;
  input.dataset.id = id;
  return element("label", { className: "check" }, [input, " ", label]);
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

export function setLanguage(locale: string, title: string): void {
  document.documentElement.lang = locale === "zh-TW" ? "zh-Hant" : "en";
  document.title = title;
}
