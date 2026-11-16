/** Types for scripts/desktop-runtime-spike/secure-directory.mjs, so TypeScript tests can import it. */
export declare function parseWhoamiSid(output: string): string;
export declare function privateDirectoryAclArguments(directory: string, userSid: string): string[];
export declare function builtinUsersWriteArguments(directory: string): string[];
export declare function securePrivateDirectory(directory: string): string;
export declare function allowBuiltinUsersToWrite(directory: string): string;
