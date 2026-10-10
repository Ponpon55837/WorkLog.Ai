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
      : Array.isArray(changedFiles)
        ? changedFiles.length
        : 0;

  return {
    ...value,
    outcome: typeof value.outcome === "string" ? value.outcome : "session",
    sessionId:
      typeof value.sessionId === "string" ? value.sessionId : typeof session?.id === "string" ? session.id : null,
    executionStatus: typeof session?.executionStatus === "string" ? session.executionStatus : "completed",
    changedFilesCount,
    verification: session?.verification ?? value.verification ?? null,
  };
}

/** Projected reads expose small factual metadata rather than duplicating selected source content. */
function toProjectionStructuredContent(value: unknown): StructuredContent | undefined {
  if (!isRecord(value) || !isRecord(value.projection) || !isRecord(value.session)) return undefined;
  const session = value.session;
  return {
    outcome: value.outcome,
    sessionId: session.id,
    projection: {
      version: value.projection.version,
      ...(value.projection.view ? { view: value.projection.view } : {}),
    },
    status: session.status,
    executionStatus: session.executionStatus,
    ...(session.voided ? { voided: session.voided } : {}),
    ...(session.verification ? { verification: session.verification } : {}),
    ...(Array.isArray(session.changedFiles) ? { changedFilesCount: session.changedFiles.length } : {}),
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

/** Tool results are compact JSON: indentation only costs the Agent tokens. */
export function textResult(value: unknown) {
  const structuredContent = toProjectionStructuredContent(value) ?? toStructuredContent(value);

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
