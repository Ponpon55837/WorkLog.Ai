/** Types for scripts/bootstrap.mjs, so tests can import it. */
export interface BootstrapDependencies {
  nodeVersion: string;
  pnpmVersion: () => string | undefined;
  requiredPnpm: string | undefined;
  interactive: boolean;
  log: (message: string) => void;
  error: (message: string) => void;
  ask: (question: string) => Promise<string>;
  runStep: (args: string[]) => number;
}
export interface BootstrapOptions {
  unknown: string[];
  yes: boolean;
  skipAgents: boolean;
  service: boolean;
  help: boolean;
}
export declare const MINIMUM_NODE: string;
export declare function parseBootstrapArguments(argv: string[]): BootstrapOptions;
export declare function defaultBootstrapDependencies(): BootstrapDependencies;
export declare function runBootstrap(argv: string[], dependencies?: BootstrapDependencies): Promise<number>;
