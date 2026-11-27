import { createSSRApp, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { renderToString } from "vue/server-renderer";
import { beforeAll, describe, expect, it } from "vitest";
import AppSidebar from "../../../apps/web/src/components/layout/AppSidebar.vue";
import { navItems, navTarget } from "../../../apps/web/src/components/layout/navigation.js";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

async function render(path: string, counts: Record<string, { value: number }>): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "dashboard", component: { render: () => null } },
      ...navItems
        .filter((item) => item.name !== "dashboard" && item.name !== "outstanding")
        .map((item) => ({ path: `/${item.name}/:tab?`, name: item.name, component: { render: () => null } })),
    ],
  });
  await router.push(path);
  const app = createSSRApp({ render: () => h(AppSidebar, { counts }) });
  app.use(router);
  return renderToString(app);
}

function link(html: string, name: string): string {
  const match = html.match(new RegExp(`<a [^>]*data-testid="nav-${name}"[^>]*>.*?</a>`));
  if (!match) throw new Error(`nav-${name} is not rendered`);
  return match[0];
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

describe("AppSidebar", () => {
  it("lists Open items beside Work history, each with its own count", async () => {
    const html = await render("/", { sessions: { value: 563 }, outstanding: { value: 12 } });

    expect(link(html, "sessions")).toContain(t("common.workHistory"));
    expect(link(html, "sessions")).toContain("563");
    expect(link(html, "outstanding")).toContain(t("common.openItems"));
    expect(link(html, "outstanding")).toContain("12");
    expect(link(html, "outstanding")).toContain('href="/sessions/outstanding"');
  });

  it("highlights only the Open items entry on the Open items tab", async () => {
    const onOutstanding = await render("/sessions/outstanding", {});
    expect(link(onOutstanding, "outstanding")).toContain("is-active");
    expect(link(onOutstanding, "sessions")).not.toContain("is-active");

    const onSessions = await render("/sessions", {});
    expect(link(onSessions, "sessions")).toContain("is-active");
    expect(link(onSessions, "outstanding")).not.toContain("is-active");

    const onReports = await render("/reports/week", {});
    expect(link(onReports, "reports")).toContain("is-active");
  });

  it("leaves the Open items entry without a counter while nothing is pending", async () => {
    const html = await render("/", { outstanding: { value: 0 } });

    expect(link(html, "outstanding")).not.toContain("ui-counter");
  });

  it("opens the Open items tab from its shortcut target", () => {
    const item = navItems.find((candidate) => candidate.name === "outstanding");

    expect(item?.shortcut).toBe("g o");
    expect(navTarget(item!)).toEqual({ name: "sessions", params: { tab: "outstanding" } });
  });
});
