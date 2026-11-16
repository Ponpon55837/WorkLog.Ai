import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Request header carrying the parent's one-time challenge to `/api/health`. */
export const INSTANCE_CHALLENGE_HEADER = "x-work-intelligence-challenge";
/** Response header carrying the HMAC the child computed for that challenge. */
export const INSTANCE_PROOF_HEADER = "x-work-intelligence-proof";

const CHALLENGE_BYTES = 32;
/** base64url charset only; the length window keeps a hostile header from costing more than a short HMAC. */
const CHALLENGE_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;
/** Separates this MAC from any other use of the same key material. */
const PROOF_CONTEXT = "work-intelligence-instance-proof:v1:";

/** A fresh unpredictable challenge: 32 random bytes as 43 base64url characters. */
export function createInstanceChallenge(): string {
  return randomBytes(CHALLENGE_BYTES).toString("base64url");
}

/** True only for a string in the exact challenge format; anything else (array header, too long, odd bytes) is refused. */
export function isValidInstanceChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_FORMAT.test(value);
}

/** HMAC-SHA256 keyed by the per-spawn `runId`, over the challenge; base64url. The runId itself never leaves the process. */
export function computeInstanceProof(runId: string, challenge: string): string {
  return createHmac("sha256", runId).update(`${PROOF_CONTEXT}${challenge}`).digest("base64url");
}

/**
 * Constant-time check that `proof` is the MAC of `challenge` under `runId`. A malformed challenge or proof is simply
 * false: the caller learns nothing beyond "not this instance".
 */
export function verifyInstanceProof(runId: string, challenge: string, proof: unknown): boolean {
  if (!isValidInstanceChallenge(challenge) || typeof proof !== "string") return false;
  const expected = Buffer.from(computeInstanceProof(runId, challenge));
  const actual = Buffer.from(proof);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
