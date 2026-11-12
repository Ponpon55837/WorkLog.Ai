import { z } from "zod";
import { findUnrecognizedKeys } from "@work-intelligence/schema";

export const MAX_INPUT_PAYLOAD_BYTES = 1_500_000;

const CUSTOM_ISSUE_CODE = "custom";
const UNRECOGNIZED_KEYS_ISSUE_CODE = "unrecognized_keys";

function inputError(message: string): z.ZodError {
  return new z.ZodError([{ code: CUSTOM_ISSUE_CODE, path: [], message }]);
}

export function parseMcpInput<T extends z.ZodType>(schema: T, input: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    return { success: false as const, error: inputError("MCP request payload must be JSON serializable.") };
  }

  if (Buffer.byteLength(serialized, "utf8") > MAX_INPUT_PAYLOAD_BYTES) {
    return {
      success: false as const,
      error: inputError("MCP request payload must not exceed " + MAX_INPUT_PAYLOAD_BYTES + " bytes."),
    };
  }

  const unrecognized = findUnrecognizedKeys(schema, input);
  if (unrecognized.length > 0) {
    return {
      success: false as const,
      error: new z.ZodError(
        unrecognized.map(({ path, keys }) => ({
          code: UNRECOGNIZED_KEYS_ISSUE_CODE,
          keys,
          path,
          message:
            "Unknown argument(s)" +
            (path.length ? " in " + path.join(".") : "") +
            ": " +
            keys.join(", ") +
            ". Check the operation contract; unknown keys are rejected, not ignored.",
        })),
      ),
    };
  }

  return schema.safeParse(input);
}
