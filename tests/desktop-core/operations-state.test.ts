import { describe, expect, it } from "vitest";
import {
  assertTransition,
  InvalidTransitionError,
  isLegalTransition,
  RestoreForbiddenError,
  SERVICE_OWNER_STATES,
  TRANSITION_EDGES,
  TRANSITION_TABLE,
} from "../../packages/desktop-core/src/index.js";

const ALL_PAIRS = SERVICE_OWNER_STATES.flatMap((from) => SERVICE_OWNER_STATES.map((to) => [from, to] as const));
const LEGAL = ALL_PAIRS.filter(([from, to]) => TRANSITION_TABLE.get(from)?.has(to));
const ILLEGAL = ALL_PAIRS.filter(([from, to]) => !TRANSITION_TABLE.get(from)?.has(to));

describe("ServiceOwner transition table", () => {
  it("has an entry and a rationale for every edge", () => {
    expect(TRANSITION_TABLE.size).toBe(SERVICE_OWNER_STATES.length);
    expect(LEGAL).toHaveLength(TRANSITION_EDGES.length);
    for (const edge of TRANSITION_EDGES) expect(edge.rationale.length).toBeGreaterThan(5);
  });

  it.each(LEGAL)("allows %s -> %s (migration not started)", (from, to) => {
    expect(isLegalTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to, false)).not.toThrow();
  });

  it.each(ILLEGAL)("rejects %s -> %s", (from, to) => {
    expect(isLegalTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to, false)).toThrow(InvalidTransitionError);
  });

  it("never allows MANAGED to be entered from outside STARTING/PREPARING", () => {
    expect(isLegalTransition("NEEDS_REPAIR", "MANAGED")).toBe(false);
    expect(isLegalTransition("EXTERNAL", "MANAGED")).toBe(false);
  });

  it("forbids every edge into EXTERNAL once migration started, and keeps other edges legal", () => {
    for (const [from, to] of LEGAL) {
      if (to === "EXTERNAL") expect(() => assertTransition(from, to, true)).toThrow(RestoreForbiddenError);
      else expect(() => assertTransition(from, to, true)).not.toThrow();
    }
  });

  it("carries the offending states on the typed errors", () => {
    const error = (() => {
      try {
        assertTransition("MANAGED", "STARTING", false);
      } catch (caught) {
        return caught as InvalidTransitionError;
      }
      return null;
    })();
    expect(error?.from).toBe("MANAGED");
    expect(error?.to).toBe("STARTING");
    expect(isLegalTransition("MANAGED", "MANAGED")).toBe(false);
  });
});
