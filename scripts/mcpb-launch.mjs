#!/usr/bin/env node
/**
 * The MCPB extension's start script (copied to `scripts/launch.mjs` of the extension by scripts/build-plugin.mjs).
 * With the desktop App installed, `mcp` runs through the App's fixed launcher (desktop-integration.mjs): it keeps
 * working after the App quits and follows App updates. Without one, the server bundled in this extension starts in this
 * process, exactly as when the manifest ran it directly.
 */
import { URL } from "node:url";
import { resolveDesktopLauncher, runDesktopLauncher } from "./desktop-integration.mjs";

const launcher = resolveDesktopLauncher("mcp");
if (launcher) runDesktopLauncher(launcher, { hook: false });
else await import(new URL("../server/apps/mcp/dist/index.js", import.meta.url).href);
