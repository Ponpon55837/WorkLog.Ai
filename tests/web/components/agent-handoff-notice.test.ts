import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { beforeAll, describe, expect, it } from "vitest";
import AgentHandoffNotice from "../../../apps/web/src/components/domain/AgentHandoffNotice.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";
import { requestStatus } from "../../../apps/web/src/utils/status.js";

type NoticeProps = InstanceType<typeof AgentHandoffNotice>["$props"];

const command = "Use Work Intelligence to do the thing";

function render(props: Partial<NoticeProps>, slots: Record<string, () => unknown> = {}): Promise<string> {
  return renderToString(
    createSSRApp({ render: () => h(AgentHandoffNotice, { message: "One sentence of explanation.", ...props }, slots) }),
  );
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

describe("AgentHandoffNotice", () => {
  it("shows the status, one sentence, the copyable Agent command and the cancel button", async () => {
    const html = await render({
      title: "Open requests",
      status: requestStatus.pending,
      command,
      cancelLabel: "Cancel request",
    });

    expect(html).toContain("Open requests");
    expect(html).toContain(requestStatus.pending.label);
    expect(html).toContain("One sentence of explanation.");
    expect(html).toContain(t("common.handoffSayToAgent"));
    expect(html).toContain(command);
    expect(html).toContain(t("common.copyAgentInstruction"));
    expect(html).toContain("Cancel request");
  });

  it("leaves out the command and the cancel button when the flow has none", async () => {
    const html = await render({});

    expect(html).toContain("One sentence of explanation.");
    expect(html).not.toContain(t("common.handoffSayToAgent"));
    expect(html).not.toContain(t("common.copyAgentInstruction"));
    expect(html).not.toContain("<button");
    expect(html).toContain('aria-label="One sentence of explanation."');
  });

  it("renders extra content and actions from its slots", async () => {
    const html = await render({}, { default: () => h("p", "Snapshot of 3"), actions: () => h("span", "Ask again") });

    expect(html).toContain("Snapshot of 3");
    expect(html).toContain("Ask again");
  });
});
