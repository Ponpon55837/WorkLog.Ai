import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const INSTANCE_CHALLENGE_HEADER = "x-work-intelligence-challenge";
export const INSTANCE_PROOF_HEADER = "x-work-intelligence-proof";

const CHALLENGE_BYTES = 32;
/** base64url charset only; the length window keeps a hostile header from costing more than a short HMAC. */
const CHALLENGE_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;
/** Separates this MAC from any other use of the same key material. */
const PROOF_CONTEXT = "work-intelligence-instance-proof:v1:";

export function createInstanceChallenge(): string {
  return randomBytes(CHALLENGE_BYTES).toString("base64url");
}

export function isValidInstanceChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_FORMAT.test(value);
}

/** The runId itself never leaves the process. */
export function computeInstanceProof(runId: string, challenge: string): string {
  return createHmac("sha256", runId).update(`${PROOF_CONTEXT}${challenge}`).digest("base64url");
}

/** Constant-time compare; any malformed input is simply false. */
export function verifyInstanceProof(runId: string, challenge: string, proof: unknown): boolean {
  if (!isValidInstanceChallenge(challenge) || typeof proof !== "string") return false;
  const expected = Buffer.from(computeInstanceProof(runId, challenge));
  const actual = Buffer.from(proof);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
