import { z } from "zod";

export type StrictParseResult<T> = { success: true; data: T } | { success: false; error: z.ZodError };

/** Object keys at one path that a schema would silently strip. */
export interface UnrecognizedKeys {
  path: (string | number)[];
  keys: string[];
}

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

function collectUnrecognizedKeys(
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
    // A key whose value is undefined carries nothing, so it is not lost (JSON input never has one).
    const unknown = allowsExtraKeys
      ? []
      : Object.keys(value).filter((key) => !Object.hasOwn(shape, key) && value[key] !== undefined);
    if (unknown.length > 0) found.push({ path, keys: unknown });
    for (const [key, child] of Object.entries(shape)) {
      if (Object.hasOwn(value, key)) collectUnrecognizedKeys(child, value[key], [...path, key], found);
    }
    if (allowsExtraKeys && catchallSchema) {
      for (const [key, child] of Object.entries(value)) {
        if (!Object.hasOwn(shape, key))
          collectUnrecognizedKeys(publicSchema(catchallSchema), child, [...path, key], found);
      }
    }
    return;
  }
  if (base instanceof z.ZodArray) {
    if (!Array.isArray(value)) return;
    value.forEach((item, index) => collectUnrecognizedKeys(publicSchema(base.element), item, [...path, index], found));
    return;
  }
  if (base instanceof z.ZodRecord) {
    if (!isPlainObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      collectUnrecognizedKeys(publicSchema(base.valueType), item, [...path, key], found);
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
      collectUnrecognizedKeys(selected, value, path, found);
      return;
    }

    // If every branch fails validation, still report the smallest unknown-key finding among compatible shapes.
    let best: UnrecognizedKeys[] | undefined;
    for (const option of base.options) {
      if (!acceptsShape(publicSchema(option), value)) continue;
      const optionFound: UnrecognizedKeys[] = [];
      collectUnrecognizedKeys(publicSchema(option), value, path, optionFound);
      if (optionFound.length === 0) return;
      if (!best || optionFound.length < best.length) best = optionFound;
    }
    if (best) found.push(...best);
  }
}

/**
 * Finds object keys the schema would silently strip. Zod's default object mode drops unknown keys, which turns a
 * misspelled argument or field into a successful call that ignored it. MCP and REST both reject what this finds.
 */
export function findUnrecognizedKeys(schema: z.ZodType, value: unknown): UnrecognizedKeys[] {
  const found: UnrecognizedKeys[] = [];
  collectUnrecognizedKeys(schema, value, [], found);
  return found;
}

/**
 * `schema.safeParse` that first rejects keys the schema would strip, naming each one in an `unrecognized_keys`
 * issue at its path, so a mistyped REST field fails with 400 instead of being dropped without a word.
 */
export function safeParseStrict<T extends z.ZodType>(schema: T, value: unknown): StrictParseResult<z.output<T>> {
  const unrecognized = findUnrecognizedKeys(schema, value);
  if (unrecognized.length === 0) {
    return schema.safeParse(value);
  }
  return {
    success: false,
    error: new z.ZodError(
      unrecognized.map(({ path, keys }) => ({
        code: "unrecognized_keys" as const,
        keys,
        path,
        message: `Unknown field(s)${path.length ? ` in ${path.join(".")}` : ""}: ${keys.join(", ")}. Unknown fields are rejected, not ignored.`,
      })),
    ),
  };
}
