import { z } from "zod";

const DECIMAL_STRING = /^\d+$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const databaseIdentitySchema = z.strictObject({
  realPath: z.string().min(1),
  fileId: z
    .strictObject({ device: z.string().regex(DECIMAL_STRING), inode: z.string().regex(DECIMAL_STRING) })
    .nullable(),
  lineageId: z.string().regex(HEX64).nullable(),
});

export type DatabaseIdentityRecord = z.infer<typeof databaseIdentitySchema>;
