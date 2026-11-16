/** Types for apps/desktop/electron-builder.config.mjs, so TypeScript tests can import it. */
export interface BuilderConfigOptions {
  stageDirectory: string;
  runtimeBundleDirectory: string;
  outputDirectory: string;
  version: string;
  compression: "store" | "normal" | "maximum";
  dmgFormat: "UDZO" | "ULFO";
  baseline?: boolean;
  electronDist?: string;
}
export declare function createBuilderConfig(options: BuilderConfigOptions): Record<string, unknown>;
