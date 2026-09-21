type StructuredContent = Record<string, unknown>;

function isRecord(value: unknown): value is StructuredContent {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildSessionStructuredContent(value: StructuredContent): StructuredContent {
  const session = isRecord(value.session) ? value.session : undefined;
  const changedFiles = session?.changedFiles ?? value.changedFiles;
  const changedFilesCount = typeof value.changedFilesCount === "number"
    ? value.changedFilesCount
    : Array.isArray(changedFiles)
      ? changedFiles.length
      : 0;

  return {
    ...value,
    outcome: typeof value.outcome === "string" ? value.outcome : "session",
    sessionId: typeof value.sessionId === "string"
      ? value.sessionId
      : typeof session?.id === "string"
        ? session.id
        : null,
    executionStatus: typeof session?.executionStatus === "string" ? session.executionStatus : "completed",
    changedFilesCount,
    verification: session?.verification ?? value.verification ?? null
  };
}

export function toSessionStructuredContent(value: unknown): StructuredContent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return buildSessionStructuredContent(value);
}

export function toStructuredContent(value: unknown): StructuredContent | undefined {
  if (!isRecord(value) || !isRecord(value.session)) {
    return undefined;
  }

  return buildSessionStructuredContent(value);
}

export function textResult(value: unknown) {
  const structuredContent = toStructuredContent(value);

  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(structuredContent ? { structuredContent } : {})
  };
}

export function sessionTextResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: toSessionStructuredContent(value) ?? {}
  };
}
