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
  /**
   * Opens the Dashboard in the browser, only at exactly `http://127.0.0.1:<the running backend's port>/`, with the one
   * handoff fragment after a port change when `handoff` is given.
   */
  open(handoff?: PortHandoff): void;
  /**
   * Opens a link in the browser, or records it (a test switch). The caller has already checked it; the update check
   * does (only links of the repository's releases).
   */
  openLink(url: string): void;
  /** The URLs recorded instead of opened (a test switch); empty otherwise. */
  readonly recorded: readonly string[];
  /** How many times the Dashboard was opened; a flow compares it before and after to avoid opening it twice. */
  opens(): number;
}

export interface DashboardOptions {
  readonly running: () => BackendInfo | undefined;
  readonly log: Logger;
  /** Test switch: record the URL instead of opening a browser. */
  readonly record: boolean;
}

export function createDashboard(options: DashboardOptions): Dashboard {
  const recorded: string[] = [];
  const counter = new DashboardOpenCounter();

  function open(handoff?: PortHandoff): void {
    const port = options.running()?.port;
    if (port === undefined) return;
    const url = dashboardUrlFor(port, handoff);
    if (!isDashboardOpenUrl(url, port)) return;
    // The record is the contract for black-box tests (see log.ts); the line never carries the URL (it may hold the handoff).
    options.log("[shell] dashboard opened");
    counter.mark();
    if (options.record) recorded.push(url);
    else void shell.openExternal(url);
  }

  function openLink(url: string): void {
    if (options.record) recorded.push(url);
    else void shell.openExternal(url);
  }

  return { open, openLink, recorded, opens: () => counter.count };
}
