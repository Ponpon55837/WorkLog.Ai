import { describe, expect, it } from "vitest";
import { DEFAULT_BACKEND_TIMEOUTS } from "../../packages/desktop-core/src/backend/types.js";
import { DEFAULT_CONNECTION_GRACE_MS } from "../../apps/server/src/shutdown.js";

describe("shutdown timing between the server and the desktop App", () => {
  it("lets the server finish its connection grace and close the worker before the App escalates to a kill", () => {
    // Equal values meant an in-flight request always ran to the App's deadline, which then killed the backend (and, on
    // Windows, left the import worker behind).
    expect(DEFAULT_CONNECTION_GRACE_MS).toBeLessThan(DEFAULT_BACKEND_TIMEOUTS.gracefulMs);
    expect(DEFAULT_BACKEND_TIMEOUTS.gracefulMs - DEFAULT_CONNECTION_GRACE_MS).toBeGreaterThanOrEqual(2_000);
  });
});
