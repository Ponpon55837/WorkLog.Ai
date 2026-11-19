/** Types for scripts/desktop-runtime-spike/node-checksums.mjs, so TypeScript tests can import it. */
export declare const PINNED_NODE_SHA256: Readonly<Record<string, Readonly<Record<string, string>>>>;
export declare function pinnedNodeSha256(version: string, archiveName: string): string | undefined;
