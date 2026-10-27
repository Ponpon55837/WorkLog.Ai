import { z } from "zod";

interface UnrecognizedKeys {
  path: (string | number)[];
  keys: string[];
}

export const MAX_INPUT_PAYLOAD_BYTES = 1_500_000;

const CUSTOM_ISSUE_CODE = "custom";
const UNRECOGNIZED_KEYS_ISSUE_CODE = "unrecognized_keys";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removes wrappers that do not change which object keys a schema accepts. */
function publicSchema(schema: unknown): z.ZodType {
  return schema as z.ZodType;
}

function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodPipe) {
      const { in: inputSchema, out: outputSchema } = current._zod.def;
      current = publicSchema(inputSchema instanceof z.ZodTransform ? outputSchema : inputSchema);
    } else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable)
      current = publicSchema(current.unwrap());
    else if (current instanceof z.ZodDefault) current = publicSchema(current.unwrap());
    else if (current instanceof z.ZodCatch) current = publicSchema(current.unwrap());
    else if (current instanceof z.ZodReadonly) current = publicSchema(current._zod.def.innerType);
    else if (current instanceof z.ZodLazy) current = publicSchema(current._zod.def.getter());
    else return current;
  }
}

/** Whether a union member could accept this value's container shape; primitives never match objects or arrays. */
function acceptsShape(schema: z.ZodType, value: unknown): boolean {
  const base = unwrapSchema(schema);
  if (base instanceof z.ZodUnion || base instanceof z.ZodDiscriminatedUnion) {
    return base.options.some((option) => acceptsShape(publicSchema(option), value));
  }
  if (base instanceof z.ZodObject || base instanceof z.ZodRecord) return isPlainObject(value);
  if (base instanceof z.ZodArray) return Array.isArray(value);
  if (base instanceof z.ZodAny || base instanceof z.ZodUnknown) return true;
  return !isPlainObject(value) && !Array.isArray(value);
}

/**
 * Finds object keys the schema would silently strip. Zod's default object mode drops unknown keys,
 * which turns a misspelled Agent argument into a successful call that ignored it.
 */
function findUnrecognizedKeys(
  schema: z.ZodType,
  value: unknown,
  path: (string | number)[],
  found: UnrecognizedKeys[],
): void {
  const base = unwrapSchema(schema);

  if (base instanceof z.ZodObject) {
    if (!isPlainObject(value)) return;
    const shape = base.shape;
    const catchallSchema = base._zod.def.catchall;
    const allowsExtraKeys = catchallSchema !== undefined && !(catchallSchema instanceof z.ZodNever);
    const unknown = allowsExtraKeys ? [] : Object.keys(value).filter((key) => !Object.hasOwn(shape, key));
    if (unknown.length > 0) found.push({ path, keys: unknown });
    for (const [key, child] of Object.entries(shape)) {
      if (Object.hasOwn(value, key)) findUnrecognizedKeys(child, value[key], [...path, key], found);
    }
    if (allowsExtraKeys && catchallSchema) {
      for (const [key, child] of Object.entries(value)) {
        if (!Object.hasOwn(shape, key))
          findUnrecognizedKeys(publicSchema(catchallSchema), child, [...path, key], found);
      }
    }
    return;
  }
  if (base instanceof z.ZodArray) {
    if (!Array.isArray(value)) return;
    value.forEach((item, index) => findUnrecognizedKeys(publicSchema(base.element), item, [...path, index], found));
    return;
  }
  if (base instanceof z.ZodRecord) {
    if (!isPlainObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      findUnrecognizedKeys(publicSchema(base.valueType), item, [...path, key], found);
    }
    return;
  }
  if (base instanceof z.ZodUnion || base instanceof z.ZodDiscriminatedUnion) {
    // Follow the branch Zod will parse, so a later union member cannot mask keys stripped by an earlier one.
    let selected: z.ZodType | undefined;
    if (base instanceof z.ZodDiscriminatedUnion) {
      if (isPlainObject(value)) {
        const discriminator = base._zod.def.discriminator;
        const selectedOption = base.options.find((option) => {
          const optionBase = unwrapSchema(publicSchema(option));
          if (!(optionBase instanceof z.ZodObject)) return false;
          const discriminatorSchema = optionBase.shape[discriminator];
          return discriminatorSchema?.safeParse(value[discriminator]).success ?? false;
        });
        selected = selectedOption ? publicSchema(selectedOption) : undefined;
      }
    } else {
      const selectedOption = base.options.find((option) => publicSchema(option).safeParse(value).success);
      selected = selectedOption ? publicSchema(selectedOption) : undefined;
    }
    if (selected) {
      findUnrecognizedKeys(selected, value, path, found);
      return;
    }

    // If every branch fails validation, still report the smallest unknown-key finding among compatible shapes.
    let best: UnrecognizedKeys[] | undefined;
    for (const option of base.options) {
      if (!acceptsShape(publicSchema(option), value)) continue;
      const optionFound: UnrecognizedKeys[] = [];
      findUnrecognizedKeys(publicSchema(option), value, path, optionFound);
      if (optionFound.length === 0) return;
      if (!best || optionFound.length < best.length) best = optionFound;
    }
    if (best) found.push(...best);
  }
}

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

  const unrecognized: UnrecognizedKeys[] = [];
  findUnrecognizedKeys(schema, input, [], unrecognized);
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
