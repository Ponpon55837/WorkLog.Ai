/**
 * electron-builder `afterPack` hook: the one place the unpacked app is finished, identically for pull-request and release
 * builds on every platform. electron-builder itself signs nothing (`mac.identity: null`).
 *
 *   1. flips the fuses (APP_FUSES) without resetting any signature;
 *   2. macOS only: ad-hoc signs the whole app inside-out (mac-ad-hoc-sign.mjs), so the seal matches the flipped binary.
 */
import { join } from "node:path";
import { APP_FUSES } from "./app-fuses.mjs";
import { adHocSignApp } from "./mac-ad-hoc-sign.mjs";

export default async function afterPack(context) {
  const { packager } = context;
  await packager.addElectronFuses(context, await packager.generateFuseConfig(APP_FUSES));
  if (context.electronPlatformName === "darwin") {
    await adHocSignApp(join(context.appOutDir, `${packager.appInfo.productFilename}.app`));
  }
}
