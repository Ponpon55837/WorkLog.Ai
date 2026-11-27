// Text is always set as text, never as HTML.

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

export function cardBody(card: HTMLElement): HTMLElement {
  return card.querySelector<HTMLElement>(":scope > .card-body") ?? card;
}

export function hint(text: string, tag: "p" | "div" | "li" = "p"): HTMLElement {
  return element(tag, { className: "hint", text });
}

export function actions(...buttons: Node[]): HTMLElement {
  return element("div", { className: "actions" }, buttons);
}

export function facts(...rows: (readonly [string, Node | string])[]): HTMLElement {
  return element(
    "dl",
    { className: "facts" },
    rows.flatMap(([label, value]) => [element("dt", { text: label }), element("dd", {}, [value])]),
  );
}

export function path(text: string): HTMLElement {
  return element("span", { className: "path", text });
}

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

export function checkbox(
  label: string,
  id: string,
  checked: boolean,
  enabled: boolean,
  onChange?: (checked: boolean) => void,
): HTMLLabelElement {
  const input = element("input", { className: "checkbox" });
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = !enabled;
  input.dataset.id = id;
  if (onChange) input.addEventListener("change", () => onChange(input.checked));
  return element("label", { className: "check" }, [input, element("span", { text: label })]);
}

/** The control with this `data-id` below `root`. */
export function byId<T extends HTMLElement = HTMLElement>(root: ParentNode, id: string): T | null {
  return root.querySelector<T>(`[data-id="${CSS.escape(id)}"]`);
}

export function isChecked(root: ParentNode, id: string): boolean {
  return byId<HTMLInputElement>(root, id)?.checked === true;
}

/** The page language only; the window title belongs to the page shell, which does not change with the tab. */
export function setLanguage(locale: string): void {
  document.documentElement.lang = locale === "zh-TW" ? "zh-Hant" : "en";
}
