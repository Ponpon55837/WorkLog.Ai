import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFocus, forgetFocus, restoreSnapshot } from "../../apps/desktop/src/renderer/repair/focus.js";

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  id = "";
  disabled = false;
  parent: FakeElement | null = null;
  constructor(readonly doc: { active: unknown }) {}
  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }
  replaceChildren(...next: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    next.forEach((child) => this.append(child));
    if (this.doc.active instanceof FakeElement && !this.contains(this.doc.active) && this.doc.active !== this) {
      this.doc.active = null;
    }
  }
  contains(node: FakeElement): boolean {
    for (let at: FakeElement | null = node; at; at = at.parent) if (at === this) return true;
    return false;
  }
  focus(): void {
    if (!this.disabled) this.doc.active = this;
  }
  querySelector<T>(selector: string): T | null {
    const id = /^\[data-id="(.*)"\]$/.exec(selector)?.[1];
    const walk = (node: FakeElement): FakeElement | null => {
      for (const child of node.children) {
        if (child.dataset.id === id) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this) as T | null;
  }
}

const doc: { active: unknown } = { active: null };

function control(id: string, disabled = false): FakeElement {
  const node = new FakeElement(doc);
  node.dataset.id = id;
  node.disabled = disabled;
  return node;
}

beforeEach(() => {
  doc.active = null;
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("HTMLInputElement", class {});
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("document", {
    get activeElement() {
      return doc.active;
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("keeping the keyboard where it was across a redraw", () => {
  it("puts the focus back on the same control after a plain redraw", () => {
    const root = new FakeElement(doc);
    const button = control("retry-start");
    root.append(button);
    button.focus();
    const snapshot = captureFocus(root as unknown as HTMLElement);
    root.replaceChildren(control("retry-start"));
    restoreSnapshot(root as unknown as HTMLElement, snapshot);
    expect(doc.active).toBe(root.children[0]);
  });

  it("finds the control again once it is enabled, after the redraw in between left the focus on the panel", () => {
    const root = new FakeElement(doc);
    const button = control("retry-start");
    root.append(button);
    button.focus();

    let snapshot = captureFocus(root as unknown as HTMLElement);
    root.replaceChildren(control("retry-start", true));
    restoreSnapshot(root as unknown as HTMLElement, snapshot);
    root.focus();
    expect(doc.active).toBe(root);

    snapshot = captureFocus(root as unknown as HTMLElement);
    expect(snapshot).not.toBeNull();
    const enabled = control("retry-start");
    root.replaceChildren(enabled);
    restoreSnapshot(root as unknown as HTMLElement, snapshot);
    expect(doc.active).toBe(enabled);
  });

  it("steals nothing when the focus is somewhere else, and forgets the control then", () => {
    const root = new FakeElement(doc);
    root.append(control("retry-start"));
    root.children[0]!.focus();
    captureFocus(root as unknown as HTMLElement);
    const elsewhere = new FakeElement(doc);
    elsewhere.focus();
    expect(captureFocus(root as unknown as HTMLElement)).toBeNull();
    root.focus();
    expect(captureFocus(root as unknown as HTMLElement)).toBeNull();
  });

  it("forgets the control when the panel is left", () => {
    const root = new FakeElement(doc);
    root.append(control("retry-start"));
    root.children[0]!.focus();
    captureFocus(root as unknown as HTMLElement);
    forgetFocus(root as unknown as HTMLElement);
    root.focus();
    expect(captureFocus(root as unknown as HTMLElement)).toBeNull();
  });
});
