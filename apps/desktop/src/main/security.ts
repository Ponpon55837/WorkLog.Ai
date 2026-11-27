import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, protocol, session } from "electron";
import { REPAIR_CSP, REPAIR_SCHEME, resolveRepairAsset } from "@work-intelligence/desktop-core";

/** The repair page's scheme must be privileged before the app is ready. */
export function registerRepairScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: REPAIR_SCHEME, privileges: { standard: true, secure: true } }]);
}

export function applySecurityPolicy(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}

/** Reading `session.defaultSession` makes Chromium keep a spare renderer ready (about 70 MB), so the policy is applied by the first window, not at start-up. */
export function createSessionPolicy(rendererDirectory: string): () => void {
  let applied = false;
  return () => {
    if (applied) return;
    applied = true;
    const current = session.defaultSession;
    current.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    current.setPermissionCheckHandler(() => false);
    current.setDevicePermissionHandler(() => false);
    protocol.handle(REPAIR_SCHEME, async (request) => {
      const headers: Record<string, string> = {
        "Content-Security-Policy": REPAIR_CSP,
        "X-Content-Type-Options": "nosniff",
      };
      const asset = resolveRepairAsset(request.url);
      if (!asset) return new Response("Not found", { status: 404, headers });
      // `asset.file` comes from a fixed table; nothing from the request is part of the path.
      const body = await readFile(join(rendererDirectory, asset.file));
      return new Response(new Uint8Array(body), { headers: { ...headers, "Content-Type": asset.contentType } });
    });
  };
}
