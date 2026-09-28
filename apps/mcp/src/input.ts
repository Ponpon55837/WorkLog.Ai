import { z } from "zod";

interface UnrecognizedKeys {
  path: (string | number)[];
  keys: string[];
}

export const MAX_INPUT_PAYLOAD_BYTES = 1_500_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removes wrappers that do not change which object keys a schema accepts. */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodEffects) current = current.innerType();
    else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap();
    else if (current instanceof z.ZodDefault) current = current.removeDefault();
    else if (current instanceof z.ZodCatch) current = current.removeCatch();
    else if (current instanceof z.ZodBranded) current = current.unwrap();
    else if (current instanceof z.ZodReadonly) current = current._def.innerType;
    else if (current instanceof z.ZodPipeline) current = current._def.in;
    else if (current instanceof z.ZodLazy) current = current.schema;
    else return current;
  }
}

/** Whether a union member could accept this value's container shape; primitives never match objects or arrays. */
function acceptsShape(schema: z.ZodTypeAny, value: unknown): boolean {
  const base = unwrapSchema(schema);
  if (base instanceof z.ZodUnion || base instanceof z.ZodDiscriminatedUnion) {
    return (base.options as z.ZodTypeAny[]).some((option) => acceptsShape(option, value));
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
  schema: z.ZodTypeAny,
  value: unknown,
  path: (string | number)[],
  found: UnrecognizedKeys[],
): void {
  const base = unwrapSchema(schema);

  if (base instanceof z.ZodObject) {
    if (!isPlainObject(value)) return;
    const shape = base.shape as z.ZodRawShape;
    const catchallSchema = base._def.catchall;
    const hasCatchall = !(catchallSchema instanceof z.ZodNever);
    const allowsExtraKeys = base._def.unknownKeys === "passthrough" || hasCatchall;
    const unknown = allowsExtraKeys ? [] : Object.keys(value).filter((key) => !Object.hasOwn(shape, key));
    if (unknown.length > 0) found.push({ path, keys: unknown });
    for (const [key, child] of Object.entries(shape)) {
      if (Object.hasOwn(value, key)) findUnrecognizedKeys(child, value[key], [...path, key], found);
    }
    if (hasCatchall) {
      for (const [key, child] of Object.entries(value)) {
        if (!Object.hasOwn(shape, key)) findUnrecognizedKeys(catchallSchema, child, [...path, key], found);
      }
    }
    return;
  }
  if (base instanceof z.ZodArray) {
    if (!Array.isArray(value)) return;
    value.forEach((item, index) => findUnrecognizedKeys(base.element, item, [...path, index], found));
    return;
  }
  if (base instanceof z.ZodRecord) {
    if (!isPlainObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      findUnrecognizedKeys(base.valueSchema, item, [...path, key], found);
    }
    return;
  }
  if (base instanceof z.ZodUnion || base instanceof z.ZodDiscriminatedUnion) {
    // Follow the branch Zod will parse, so a later union member cannot mask keys stripped by an earlier one.
    let selected: z.ZodTypeAny | undefined;
    if (base instanceof z.ZodDiscriminatedUnion) {
      if (isPlainObject(value)) {
        selected = base.optionsMap.get(value[base.discriminator] as Parameters<typeof base.optionsMap.get>[0]);
      }
    } else {
      selected = (base.options as z.ZodTypeAny[]).find((option) => option.safeParse(value).success);
    }
    if (selected) {
      findUnrecognizedKeys(selected, value, path, found);
      return;
    }

    // If every branch fails validation, still report the smallest unknown-key finding among compatible shapes.
    let best: UnrecognizedKeys[] | undefined;
    for (const option of base.options as z.ZodTypeAny[]) {
      if (!acceptsShape(option, value)) continue;
      const optionFound: UnrecognizedKeys[] = [];
      findUnrecognizedKeys(option, value, path, optionFound);
      if (optionFound.length === 0) return;
      if (!best || optionFound.length < best.length) best = optionFound;
    }
    if (best) found.push(...best);
  }
}

function inputError(message: string): z.ZodError {
  return new z.ZodError([{ code: z.ZodIssueCode.custom, path: [], message }]);
}

export function parseMcpInput<T extends z.ZodTypeAny>(schema: T, input: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    return { success: false as const, error: inputError("MCP request payload must be JSON serializable.") };
  }

  if (Buffer.byteLength(serialized, "utf8") > MAX_INPUT_PAYLOAD_BYTES) {
    return {
      success: false as const,
      error: inputError(`MCP request payload must not exceed ${MAX_INPUT_PAYLOAD_BYTES} bytes.`),
    };
  }

  const unrecognized: UnrecognizedKeys[] = [];
  findUnrecognizedKeys(schema, input, [], unrecognized);
  if (unrecognized.length > 0) {
    return {
      success: false as const,
      error: new z.ZodError(
        unrecognized.map(({ path, keys }) => ({
          code: z.ZodIssueCode.unrecognized_keys,
          keys,
          path,
          message: `Unknown argument(s)${path.length ? ` in ${path.join(".")}` : ""}: ${keys.join(", ")}. Check the operation contract; unknown keys are rejected, not ignored.`,
        })),
      ),
    };
  }

  return schema.safeParse(input);
}
