import { z } from "zod";

/** Decimal digit string; device/inode are stringified bigints so they survive JSON without precision loss. */
const DECIMAL_STRING = /^\d+$/;
/** sha256 hex digest, lowercase. */
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Zod schema of a persisted DatabaseIdentity (composite identity, never a path or project count alone).
 * Shared by the settings file and the DB-source detector so both persist and validate the same shape.
 */
export const databaseIdentitySchema = z.strictObject({
  realPath: z.string().min(1),
  fileId: z
    .strictObject({ device: z.string().regex(DECIMAL_STRING), inode: z.string().regex(DECIMAL_STRING) })
    .nullable(),
  lineageId: z.string().regex(HEX64).nullable(),
});

/** Persisted form of a database identity. */
export type DatabaseIdentityRecord = z.infer<typeof databaseIdentitySchema>;
