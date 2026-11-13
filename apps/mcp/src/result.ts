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
  // A finalize receipt carries the verification status only, not the submitted verification body.
  const verification =
    session?.verification ??
    value.verification ??
    (typeof session?.verificationStatus === "string" ? { status: session.verificationStatus } : null);

  return {
    ...value,
    outcome: typeof value.outcome === "string" ? value.outcome : "session",
    sessionId:
      typeof value.sessionId === "string" ? value.sessionId : typeof session?.id === "string" ? session.id : null,
    executionStatus: typeof session?.executionStatus === "string" ? session.executionStatus : "completed",
    changedFilesCount,
    verification,
  };
}

/**
 * A projected read (view/select) answers in text only. Some clients hand the model structuredContent
 * instead of the text when both are present, so a metadata-only structuredContent hid the selected
 * body from the Agent; repeating the body there would send it twice to clients that pass both.
 */
function isProjectedSessionRead(value: unknown): boolean {
  return isRecord(value) && isRecord(value.projection) && isRecord(value.session);
}

/**
 * session_unchanged carries identity only; Session-shaped defaults (0 changed files, no verification) would mislead.
 * Everything the text says stays, because some clients hand the model structuredContent instead of the text.
 */
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
 * The structured form of a Session tool's result. A result that carries a Session gets the stable Session fields;
 * any other result (skipped, idempotency_conflict, not_found) is passed through unchanged, because defaults such as
 * executionStatus "completed" would tell a client that reads only structuredContent that something was saved.
 */
export function toSessionStructuredContent(value: unknown): StructuredContent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isRecord(value.session) ? buildSessionStructuredContent(value) : value;
}

export function toStructuredContent(value: unknown): StructuredContent | undefined {
  if (!isRecord(value) || !isRecord(value.session)) {
    return undefined;
  }

  return buildSessionStructuredContent(value);
}

/** Tool results are compact JSON: indentation only costs the Agent tokens. */
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
