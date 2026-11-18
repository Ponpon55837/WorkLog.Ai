import { portMessages } from "@work-intelligence/desktop-core/shell/port-i18n";
import { updateMessages } from "@work-intelligence/desktop-core/shell/update-i18n";
import type { ViewContext } from "./context.js";
import { portSection } from "./port-view.js";
import { updateSection } from "./update-view.js";

/** The Settings tab: the port the service uses and the update check. */
export function settingsPanel(ctx: ViewContext): Node[] {
  const { state, act } = ctx;
  const blocks: Node[] = [];
  if (state.port) {
    blocks.push(
      portSection(
        {
          api: act.api,
          text: portMessages(state.locale),
          working: ctx.busy,
          rerender: act.rerender,
          refresh: act.refresh,
        },
        state.port,
      ),
    );
  }
  if (state.update) {
    blocks.push(
      updateSection(
        {
          api: act.api,
          text: updateMessages(state.locale),
          locale: state.locale,
          rerender: act.rerender,
          refresh: act.refresh,
        },
        state.update,
      ),
    );
  }
  return blocks;
}
