import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeInstanceProof,
  createInstanceChallenge,
  INSTANCE_CHALLENGE_HEADER,
  INSTANCE_PROOF_HEADER,
  isValidInstanceChallenge,
  verifyInstanceProof,
} from "../../packages/shared/src/instance-proof.js";
import { probeLoopbackPort } from "../../packages/shared/src/loopback-port.js";

const RUN_ID = "synthetic-run-id-0123456789abcdef";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

describe("instance proof", () => {
  it("creates distinct base64url challenges that pass the format check", () => {
    const a = createInstanceChallenge();
    const b = createInstanceChallenge();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isValidInstanceChallenge(a)).toBe(true);
  });

  it("verifies the proof of the same run id and challenge", () => {
    const challenge = createInstanceChallenge();
    const proof = computeInstanceProof(RUN_ID, challenge);
    expect(proof).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyInstanceProof(RUN_ID, challenge, proof)).toBe(true);
  });

  it("rejects a proof from another run id, another challenge, or a different length", () => {
    const challenge = createInstanceChallenge();
    const proof = computeInstanceProof(RUN_ID, challenge);
    expect(verifyInstanceProof("another-run-id-0123456789abcdef", challenge, proof)).toBe(false);
    expect(verifyInstanceProof(RUN_ID, createInstanceChallenge(), proof)).toBe(false);
    expect(verifyInstanceProof(RUN_ID, challenge, proof.slice(1))).toBe(false);
    expect(verifyInstanceProof(RUN_ID, challenge, `${proof}A`)).toBe(false);
    expect(verifyInstanceProof(RUN_ID, challenge, undefined)).toBe(false);
    expect(verifyInstanceProof(RUN_ID, challenge, ["x"])).toBe(false);
  });

  it.each([
    ["too short", "a".repeat(15)],
    ["too long", "a".repeat(129)],
    ["a space", `${"a".repeat(20)} b`],
    ["a plus sign", `${"a".repeat(20)}+`],
    ["a newline", `${"a".repeat(20)}\n`],
    ["empty", ""],
  ])("rejects a challenge that is %s", (_name, value) => {
    expect(isValidInstanceChallenge(value)).toBe(false);
    expect(verifyInstanceProof(RUN_ID, value, computeInstanceProof(RUN_ID, value))).toBe(false);
  });

  it("rejects a challenge that is not a string", () => {
    expect(isValidInstanceChallenge(undefined)).toBe(false);
    expect(isValidInstanceChallenge(["a".repeat(20)])).toBe(false);
  });

  it("names its headers in lower case", () => {
    expect(INSTANCE_CHALLENGE_HEADER).toBe("x-work-intelligence-challenge");
    expect(INSTANCE_PROOF_HEADER).toBe("x-work-intelligence-proof");
  });
});

describe("probeLoopbackPort", () => {
  it("reports a free port and then the code of an occupied one", async () => {
    const holder = createServer();
    servers.push(holder);
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const address = holder.address();
    if (!address || typeof address === "string") throw new Error("no port");

    expect(await probeLoopbackPort(address.port)).toEqual({ free: false, code: "EADDRINUSE" });
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    expect(await probeLoopbackPort(address.port)).toEqual({ free: true });
  });
});
