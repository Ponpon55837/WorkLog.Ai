import { createPinia, setActivePinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString, type SSRContext } from "vue/server-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeRecord, ProjectRecord, SessionDecisionRecord } from "@work-intelligence/core";
import KnowledgeEditorDialog from "../../../apps/web/src/components/domain/KnowledgeEditorDialog.vue";
import { useKnowledgeActions } from "../../../apps/web/src/composables/useKnowledge.js";
import { useKnowledgeEditorStore } from "../../../apps/web/src/stores/knowledge-editor.js";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

vi.mock("../../../apps/web/src/composables/useFocusTrap", () => ({ useFocusTrap: () => undefined }));

const decision = {
  id: "d1",
  sessionId: "session-1",
  projectId: "project-1",
  text: "Project paths are read only from the central registry because the CLI also needs them.",
} as SessionDecisionRecord;
const project = { id: "project-1", name: "Orchard", rootPath: "/work/orchard" } as ProjectRecord;

let pinia = createPinia();

async function renderDialog(): Promise<string> {
  const app = createSSRApp({ render: () => h(KnowledgeEditorDialog) }).use(pinia);
  const context: SSRContext = {};
  const html = await renderToString(app, context);
  return html + String(context.teleports?.["body"] ?? "");
}

function tag(html: string, pattern: RegExp): string {
  return html.match(pattern)?.[0] ?? "";
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

describe("turning an Agent decision into Knowledge", () => {
  it("fills the body with the decision and leaves the title and tags empty", () => {
    const actions = useKnowledgeActions();

    actions.openAgentDecisionEditor(decision, project);

    expect(actions.knowledgeEditorForm.value).toMatchObject({
      kind: "decision",
      title: "",
      body: decision.text,
      tags: "",
    });
  });

  it("puts the cursor in the body and explains how to write the title", async () => {
    useKnowledgeActions().openAgentDecisionEditor(decision, project);

    const html = await renderDialog();

    expect(html).toContain(t("knowledge.titleHint"));
    expect(tag(html, /<input[^>]*maxlength="300"[^>]*>/)).toContain(`placeholder="${t("knowledge.titlePlaceholder")}"`);
    expect(tag(html, /<input[^>]*maxlength="300"[^>]*>/)).not.toContain("autofocus");
    expect(tag(html, /<textarea[^>]*maxlength="20000"[^>]*>/)).toContain("autofocus");
  });

  it("keeps the cursor in the title when editing existing Knowledge", async () => {
    const item = {
      id: "k1",
      title: "Registry",
      body: "Body",
      tags: [],
      references: [],
      appliesTo: [],
    } as unknown as KnowledgeRecord;
    useKnowledgeEditorStore().knowledgeEditor = item;

    const html = await renderDialog();

    expect(html).not.toContain(t("knowledge.titleHint"));
    expect(tag(html, /<input[^>]*maxlength="300"[^>]*>/)).toContain("autofocus");
    expect(tag(html, /<textarea[^>]*maxlength="20000"[^>]*>/)).not.toContain("autofocus");
  });
});
