import { shell } from "electron";
import {
  DashboardOpenCounter,
  dashboardUrlFor,
  isDashboardOpenUrl,
  type BackendInfo,
} from "@work-intelligence/desktop-core";
import type { PortHandoff } from "@work-intelligence/schema";
import type { Logger } from "./log.js";

export interface Dashboard {
  open(handoff?: PortHandoff): void;
  openLink(url: string): Promise<boolean>;
  readonly recorded: readonly string[];
  opens(): number;
}

export interface DashboardOptions {
  readonly running: () => BackendInfo | undefined;
  readonly log: Logger;
  readonly record: boolean;
  readonly openExternal?: (url: string) => Promise<void>;
}

export function createDashboard(options: DashboardOptions): Dashboard {
  const recorded: string[] = [];
  const counter = new DashboardOpenCounter();
  const openExternal = options.openExternal ?? ((url: string) => shell.openExternal(url));

  function open(handoff?: PortHandoff): void {
    const port = options.running()?.port;
    if (port === undefined) return;
    const url = dashboardUrlFor(port, handoff);
    if (!isDashboardOpenUrl(url, port)) return;
    // Black-box tests read this line (see log.ts); it never carries the URL, which may hold the handoff.
    options.log("[shell] dashboard opened");
    counter.mark();
    if (options.record) recorded.push(url);
    else void openExternal(url).catch(() => options.log("[shell] dashboard open failed"));
  }

  async function openLink(url: string): Promise<boolean> {
    if (options.record) {
      recorded.push(url);
      return true;
    }
    try {
      await openExternal(url);
      return true;
    } catch {
      return false;
    }
  }

  return { open, openLink, recorded, opens: () => counter.count };
}
