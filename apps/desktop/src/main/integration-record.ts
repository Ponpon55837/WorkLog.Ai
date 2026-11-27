import {
  integrationRecordPath,
  publishIntegrationRecord,
  writeDesktopSettingsPointer,
  type IntegrationDirectoryInputs,
  type IntegrationRecordInputs,
} from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";

export interface IntegrationPublisher {
  /** Never throws: a start must not fail because the record could not be written. */
  publish(): Promise<void>;
}

export interface IntegrationPublisherOptions extends IntegrationDirectoryInputs {
  readonly paths: Pick<DesktopPaths, "runtimeRoot" | "settingsFile">;
  readonly appExecutable: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly log: Logger;
}

export function createIntegrationPublisher(options: IntegrationPublisherOptions): IntegrationPublisher {
  const inputs: IntegrationRecordInputs = {
    runtimeRoot: options.paths.runtimeRoot,
    appExecutable: options.appExecutable,
    appVersion: options.appVersion,
  };
  let published = false;

  return {
    publish: async () => {
      if (published) return;
      try {
        const result = await publishIntegrationRecord(integrationRecordPath(options), inputs, {
          platform: options.platform,
        });
        published = true;
        if (result === "written") options.log("[shell] desktop integration record written");
      } catch (error) {
        // A file-system error message carries paths: log the code only.
        options.log(`[shell] desktop integration record failed: ${(error as NodeJS.ErrnoException).code ?? "invalid"}`);
      }
      try {
        // Where the launcher finds the App's settings, so Agents open the committed database (ADR-39).
        const pointer = await writeDesktopSettingsPointer(
          options.paths.runtimeRoot,
          options.paths.settingsFile,
          options.platform,
        );
        if (pointer === "written") options.log("[shell] desktop settings pointer written");
      } catch (error) {
        options.log(`[shell] desktop settings pointer failed: ${(error as NodeJS.ErrnoException).code ?? "invalid"}`);
      }
    },
  };
}
