import console from "node:console";
import { join } from "node:path";
import { APP_FUSES } from "./app-fuses.mjs";
import { adHocSignApp, describeSigningPlan } from "./mac-ad-hoc-sign.mjs";

export default async function afterPack(context) {
  const { packager } = context;
  await packager.addElectronFuses(context, await packager.generateFuseConfig(APP_FUSES));
  const fuses = Object.entries(APP_FUSES).map(([name, enabled]) => `${name}=${enabled ? "on" : "off"}`);
  console.log(`[afterPack] fuses flipped: ${fuses.join(" ")}`);
  if (context.electronPlatformName === "darwin") {
    const signed = await adHocSignApp(join(context.appOutDir, `${packager.appInfo.productFilename}.app`));
    console.log(`[afterPack] ad-hoc signed ${signed.length} paths inside-out: ${describeSigningPlan(signed)}`);
  }
}
