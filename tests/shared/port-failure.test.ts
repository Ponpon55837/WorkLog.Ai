import { describe, expect, it } from "vitest";
import { portFailureCode } from "../../packages/shared/src/port-failure.js";

describe("portFailureCode", () => {
  it("separates a port the OS does not allow from one another program holds", () => {
    expect(portFailureCode("EACCES")).toBe("PORT_NOT_PERMITTED");
    expect(portFailureCode("EADDRNOTAVAIL")).toBe("PORT_NOT_PERMITTED");
    expect(portFailureCode("EADDRINUSE")).toBe("PORT_OCCUPIED_BY_OTHER");
    expect(portFailureCode("UNKNOWN")).toBe("PORT_OCCUPIED_BY_OTHER");
  });
});
