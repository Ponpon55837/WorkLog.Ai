#!/usr/bin/env node
/**
 * Starts the desktop App's fixed launcher when it is ready; otherwise runs the bundled server in this process. A launcher
 * that is not ready is never started, because the host's first message is still unread on stdin.
 */
import console from "node:console";
import { URL } from "node:url";
import { resolveDesktopLauncher, runDesktopLauncher } from "./desktop-integration.mjs";

const launcher = resolveDesktopLauncher("mcp", {
  onProblem: (problem) => console.error(`Work Intelligence: the desktop App's launcher is not used: ${problem}.`),
});
if (launcher) runDesktopLauncher(launcher, { hook: false });
else await import(new URL("../server/apps/mcp/dist/index.js", import.meta.url).href);
