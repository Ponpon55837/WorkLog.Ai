type StructuredContent = Record<string, unknown>;

function isRecord(value: unknown): value is StructuredContent {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildSessionStructuredContent(value: StructuredContent): StructuredContent {
  const session = isRecord(value.session) ? value.session : undefined;
  const changedFiles = session?.changedFiles ?? value.changedFiles;
  const changedFilesCount =
    typeof value.changedFilesCount === "number"
      ? value.changedFilesCount
      : typeof session?.changedFilesCount === "number"
        ? session.changedFilesCount
        : Array.isArray(changedFiles)
          ? changedFiles.length
          : 0;
  const verification =
    session?.verification ??
    value.verification ??
    (typeof session?.verificationStatus === "string" ? { status: session.verificationStatus } : null);

  return {
    ...value,
    outcome: typeof value.outcome === "string" ? value.outcome : "session",
    sessionId:
      typeof value.sessionId === "string" ? value.sessionId : typeof session?.id === "string" ? session.id : null,
    ...(isRecord(verification) && verification.status === "in_progress"
      ? {}
      : { executionStatus: typeof session?.executionStatus === "string" ? session.executionStatus : "completed" }),
    changedFilesCount,
    verification,
  };
}

/** A projected read answers in text only: some clients show the model structuredContent instead of the text, which would hide the selected body or send it twice. */
function isProjectedSessionRead(value: unknown): boolean {
  return isRecord(value) && isRecord(value.projection) && isRecord(value.session);
}

/** session_unchanged carries identity only: Session-shaped defaults would mislead, and the text stays because some clients read only structuredContent. */
function toUnchangedStructuredContent(value: unknown): StructuredContent | undefined {
  if (!isRecord(value) || value.outcome !== "session_unchanged" || !isRecord(value.session)) return undefined;
  const session = value.session;
  return {
    ...value,
    sessionId: session.id,
    revision: session.revision,
    ...(session.voided ? { voided: session.voided } : {}),
  };
}

/**
 * Non-Session results pass through: defaults such as executionStatus "completed" would tell a structuredContent-only client something was saved.
 * @internal test-only
 */
export function toSessionStructuredContent(value: unknown): StructuredContent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isRecord(value.session) ? buildSessionStructuredContent(value) : value;
}

/** @internal test-only */
export function toStructuredContent(value: unknown): StructuredContent | undefined {
  if (!isRecord(value) || !isRecord(value.session)) {
    return undefined;
  }

  return buildSessionStructuredContent(value);
}

export function textResult(value: unknown) {
  const structuredContent = isProjectedSessionRead(value)
    ? undefined
    : (toUnchangedStructuredContent(value) ?? toStructuredContent(value));

  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

export function sessionTextResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: toSessionStructuredContent(value) ?? {},
  };
}

/** Sum of text content lengths plus JSON.stringify(structuredContent).length, in UTF-16 code units (not bytes or tokens). */
export function countResponseChars(response: {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  structuredContent?: unknown;
}): number {
  let total = 0;
  for (const item of response.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") total += item.text.length;
  }
  if (response.structuredContent !== undefined) total += JSON.stringify(response.structuredContent).length;
  return total;
}
