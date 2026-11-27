import { diagnosticsMessages } from "@work-intelligence/desktop-core/shell/diagnostics-i18n";
import type { ViewContext } from "./context.js";
import { actions, button, hint, section } from "./dom.js";

export function diagnosticsPanel(ctx: ViewContext): Node[] {
  const { state, messages } = ctx;
  const text = diagnosticsMessages(state.locale);
  const action = state.actions.find((entry) => entry.id === "export-diagnostics");
  return [
    section(
      messages.tabLabels.diagnostics,
      hint(text.tabIntro),
      actions(
        button(
          messages.actionExport,
          "export-diagnostics",
          (action?.enabled ?? true) && !ctx.busy,
          () => ctx.act.perform("export-diagnostics"),
          true,
        ),
      ),
    ),
  ];
}
