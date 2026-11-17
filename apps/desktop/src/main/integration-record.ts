import {
  integrationRecordPath,
  publishIntegrationRecord,
  type IntegrationDirectoryInputs,
  type IntegrationRecordInputs,
} from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";

export interface IntegrationPublisher {
  /**
   * Tells Agents where the launcher and the App are (`desktop-integration.json`). Call it after the runtime is current.
   * It never throws: the record is a convenience, and a start must not fail because it could not be written.
   */
  publish(): Promise<void>;
}

export interface IntegrationPublisherOptions extends IntegrationDirectoryInputs {
  readonly paths: Pick<DesktopPaths, "runtimeRoot">;
  /** `process.execPath`: the App's own executable. */
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
      // The inputs cannot change while the App runs, so the file is looked at once per process, not at every restart.
      if (published) return;
      try {
        const result = await publishIntegrationRecord(integrationRecordPath(options), inputs, {
          platform: options.platform,
        });
        published = true;
        if (result === "written") options.log("[shell] desktop integration record written");
      } catch (error) {
        // The message of a file-system error carries paths: log the code only.
        options.log(`[shell] desktop integration record failed: ${(error as NodeJS.ErrnoException).code ?? "invalid"}`);
      }
    },
  };
}
