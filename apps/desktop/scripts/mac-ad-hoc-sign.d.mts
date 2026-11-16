/** Types for apps/desktop/scripts/mac-ad-hoc-sign.mjs, so TypeScript tests can import it. */
export interface AppEntry {
  path: string;
  type: "file" | "directory";
  machO?: boolean;
}
export declare function isMachOHeader(bytes: Uint8Array): boolean;
export declare function planSigningOrder(entries: AppEntry[]): string[];
export declare function listAppEntries(root: string): AppEntry[];
export declare function adHocSignApp(appPath: string): Promise<string[]>;
export declare function describeSigningPlan(plan: string[]): string;
