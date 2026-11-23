import { languageMessages } from "@work-intelligence/desktop-core/shell/language-i18n";
import { loginItemMessages } from "@work-intelligence/desktop-core/shell/login-item-i18n";
import { portMessages } from "@work-intelligence/desktop-core/shell/port-i18n";
import { updateMessages } from "@work-intelligence/desktop-core/shell/update-i18n";
import { backupDirectorySection } from "./backup-directory-view.js";
import type { ViewContext } from "./context.js";
import { languageSection } from "./language-view.js";
import { loginItemSection } from "./login-item-view.js";
import { portSection } from "./port-view.js";
import { updateSection } from "./update-view.js";

/** The Settings tab: the language, the port the service uses, the backup location, start at login and the update check. */
export function settingsPanel(ctx: ViewContext): Node[] {
  const { state, act } = ctx;
  const blocks: Node[] = [];
  if (state.language) {
    blocks.push(
      languageSection(
        { api: act.api, text: languageMessages(state.locale), rerender: act.rerender, refresh: act.refresh },
        state.language,
      ),
    );
  }
  if (state.port) {
    blocks.push(
      portSection(
        {
          api: act.api,
          text: portMessages(state.locale),
          working: ctx.busy,
          focusPort: ctx.focusPort,
          rerender: act.rerender,
          refresh: act.refresh,
        },
        state.port,
      ),
    );
  }
  if (state.backupDirectory) {
    blocks.push(
      backupDirectorySection(
        { api: act.api, locale: state.locale, pageBusy: ctx.busy, rerender: act.rerender, refresh: act.refresh },
        state.backupDirectory,
      ),
    );
  }
  if (state.loginItem) {
    blocks.push(
      loginItemSection(
        {
          api: act.api,
          text: loginItemMessages(state.locale),
          working: ctx.busy,
          rerender: act.rerender,
          refresh: act.refresh,
        },
        state.loginItem,
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
