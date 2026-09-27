import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { EDITOR_PROTOCOLS, type EditorProtocol } from "../utils/code-links";

const EDITOR_KEY = "work-intelligence:editor";

/** Browser storage can be missing or blocked (private windows, previews); the preference then lasts one visit. */
function readEditor(): EditorProtocol {
  try {
    const stored = window.localStorage.getItem(EDITOR_KEY);
    return (EDITOR_PROTOCOLS as readonly string[]).includes(stored ?? "") ? (stored as EditorProtocol) : "none";
  } catch {
    return "none";
  }
}

/** Personal preferences kept in this browser only, never sent to the local API. */
export const usePreferencesStore = defineStore("preferences", () => {
  const editor = ref<EditorProtocol>(readEditor());

  watch(editor, (value) => {
    try {
      window.localStorage.setItem(EDITOR_KEY, value);
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  });

  function $reset(): void {
    editor.value = "none";
  }

  return { editor, $reset };
});
