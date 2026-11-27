import { z } from "zod";

const INVALID_UNION_ISSUE_CODE = "invalid_union";
const UNRECOGNIZED_KEYS_ISSUE_CODE = "unrecognized_keys";

function branchDepth(branch: readonly z.core.$ZodIssue[]): number {
  return branch.reduce((deepest, issue) => Math.max(deepest, issue.path.length), 0);
}

function expandUnionIssue(issue: z.core.$ZodIssue): z.core.$ZodIssue[] {
  if (issue.code !== INVALID_UNION_ISSUE_CODE || issue.errors.length === 0) {
    return [issue];
  }
  const branch = issue.errors.reduce((best, candidate) =>
    branchDepth(candidate) > branchDepth(best) ? candidate : best,
  );
  return branch.flatMap((nested) => expandUnionIssue({ ...nested, path: [...issue.path, ...nested.path] }));
}

/** Field errors keep the nested path (`scope: …` under `workSummary`), so a caller can fix the exact key. */
export function flattenInputError(error: z.ZodError): {
  formErrors: string[];
  fieldErrors: Record<string, string[] | undefined>;
} {
  return new z.ZodError(error.issues.flatMap(expandUnionIssue)).flatten((issue) =>
    issue.path.length > 1 && issue.code !== UNRECOGNIZED_KEYS_ISSUE_CODE
      ? issue.path.slice(1).join(".") + ": " + issue.message
      : issue.message,
  );
}
