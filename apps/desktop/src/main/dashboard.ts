import { shell } from "electron";
import { isDashboardUrl, type BackendInfo } from "@work-intelligence/desktop-core";

export interface Dashboard {
  /** Opens the Dashboard in the browser, only at exactly `http://127.0.0.1:<the running backend's port>/`. */
  open(): void;
  /** The URLs recorded instead of opened (a test switch); empty otherwise. */
  readonly recorded: readonly string[];
}

export interface DashboardOptions {
  readonly running: () => BackendInfo | undefined;
  /** Test switch: record the URL instead of opening a browser. */
  readonly record: boolean;
}

export function createDashboard(options: DashboardOptions): Dashboard {
  const recorded: string[] = [];

  function open(): void {
    const port = options.running()?.port;
    if (port === undefined) return;
    const url = `http://127.0.0.1:${port}/`;
    if (!isDashboardUrl(url, port)) return;
    if (options.record) recorded.push(url);
    else void shell.openExternal(url);
  }

  return { open, recorded };
}
