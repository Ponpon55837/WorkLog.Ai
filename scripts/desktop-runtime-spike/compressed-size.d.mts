/** Types for scripts/desktop-runtime-spike/compressed-size.mjs, so tests can import it. */
export interface TarFile {
  readonly path: string;
  readonly size: number;
}
export interface TarSymlink {
  readonly path: string;
  readonly target: string;
}
export declare function tarStream(
  directory: string,
  files: readonly TarFile[],
  symlinks?: readonly TarSymlink[],
): AsyncGenerator<Buffer>;
export declare function compressedTarSize(
  directory: string,
  files: readonly TarFile[],
  symlinks?: readonly TarSymlink[],
): Promise<number>;
