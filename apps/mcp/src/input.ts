import { z } from "zod";

export const MAX_INPUT_PAYLOAD_BYTES = 1_500_000;

export function parseMcpInput<T extends z.ZodTypeAny>(schema: T, input: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    return {
      success: false as const,
      error: new z.ZodError([{
        code: z.ZodIssueCode.custom,
        path: [],
        message: "MCP request payload must be JSON serializable."
      }])
    };
  }

  if (Buffer.byteLength(serialized, "utf8") > MAX_INPUT_PAYLOAD_BYTES) {
    return {
      success: false as const,
      error: new z.ZodError([{
        code: z.ZodIssueCode.custom,
        path: [],
        message: `MCP request payload must not exceed ${MAX_INPUT_PAYLOAD_BYTES} bytes.`
      }])
    };
  }

  return schema.safeParse(input);
}
