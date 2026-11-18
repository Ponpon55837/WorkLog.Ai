/** Types for scripts/check-audit-ignores.mjs, so tests can import it. */
export interface AllowedAuditIgnore {
  readonly package: string;
  readonly vulnerableUpTo: string;
}
export declare const ALLOWED_AUDIT_IGNORES: Readonly<Record<string, AllowedAuditIgnore>>;
export declare function readWorkspaceFiles(): { workspaceYaml: string; lockfileText: string };
export declare function parseIgnoreGhsas(workspaceYaml: string): string[];
export declare function withoutAuditConfig(workspaceYaml: string): string;
export declare function lockfileVersions(lockfileText: string, name: string): string[];
export declare function compareVersions(a: string, b: string): number;
export declare function auditIgnoreProblems(input: {
  ignored: readonly string[];
  lockfileText: string;
  reportedGhsas: readonly string[] | null;
  allowed?: Readonly<Record<string, AllowedAuditIgnore>>;
}): string[];
export declare const REMOVAL_STEPS: string;
export declare function registryProblems(input: {
  ignored: readonly string[];
  registryVersions: Readonly<Record<string, readonly string[] | undefined>>;
  allowed?: Readonly<Record<string, AllowedAuditIgnore>>;
}): string[];
