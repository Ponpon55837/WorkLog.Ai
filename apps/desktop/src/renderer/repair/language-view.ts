import type { RepairApi } from "@work-intelligence/desktop-core";
import {
  LANGUAGE_CHOICES,
  languageChoiceLabel,
  type LanguageMessages,
  type RepairLanguageSection,
} from "@work-intelligence/desktop-core/shell/language-i18n";
import { element, hint, section } from "./dom.js";

/** A choice was made and main has not answered yet: keeps it from being changed twice. */
let pending = false;
let failed = false;

interface LanguageViewHost {
  readonly api: RepairApi;
  readonly text: LanguageMessages;
  readonly rerender: () => void;
  readonly refresh: () => void;
}

async function change(host: LanguageViewHost, preference: RepairLanguageSection["preference"]): Promise<void> {
  if (pending) return;
  pending = true;
  failed = false;
  host.rerender();
  try {
    failed = !(await host.api.setLanguage(preference)).ok;
  } catch {
    failed = true;
  }
  pending = false;
  // The new state carries the new language: the whole page is drawn in it at once.
  host.refresh();
  host.rerender();
}

/** The 「語言」 card: 跟隨系統 / 繁體中文 / English, one radio button each. */
export function languageSection(host: LanguageViewHost, language: RepairLanguageSection): HTMLElement {
  const { text } = host;
  const choices = element("fieldset", { className: "choices" }, [
    element("legend", { className: "field-label", text: text.label }),
    ...LANGUAGE_CHOICES.map((choice) => {
      const input = element("input", { className: "checkbox" });
      input.type = "radio";
      input.name = "language";
      input.value = choice;
      input.dataset.id = `language-${choice}`;
      input.checked = language.preference === choice;
      input.disabled = pending;
      input.addEventListener("change", () => {
        if (input.checked) void change(host, choice);
      });
      return element("label", { className: "check" }, [
        input,
        element("span", { text: languageChoiceLabel(text, choice, language.systemLocale) }),
      ]);
    }),
  ]);
  const card = section(text.heading, hint(text.intro), choices, ...(failed ? [hint(text.failed)] : []));
  card.id = "language-section";
  return card;
}
