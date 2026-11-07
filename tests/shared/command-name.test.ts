import { describe, expect, it } from "vitest";
import { commandName, STANDALONE_COMMAND_NAME } from "../../packages/shared/src/command-name.js";

describe("commandName", () => {
  it("shows the pnpm script in a checkout", () => {
    expect(commandName("check", false)).toBe("pnpm check");
    expect(commandName("db:backup", false)).toBe("pnpm db:backup");
    expect(commandName("setup:agents", false)).toBe("pnpm setup:agents");
  });

  it("shows the work-intelligence command for a standalone package", () => {
    expect(STANDALONE_COMMAND_NAME).toBe("work-intelligence");
    expect(commandName("start", true)).toBe("work-intelligence start");
    expect(commandName("check", true)).toBe("work-intelligence check");
    expect(commandName("track", true)).toBe("work-intelligence track");
  });

  it("turns db:* scripts into the db subcommand", () => {
    expect(commandName("db:maintain", true)).toBe("work-intelligence db maintain");
    expect(commandName("db:backups", true)).toBe("work-intelligence db backups");
  });

  it("maps scripts whose standalone name differs", () => {
    expect(commandName("bootstrap", true)).toBe("work-intelligence setup");
    expect(commandName("setup:agents", true)).toBe("work-intelligence setup-agents");
    expect(commandName("service:install", true)).toBe("work-intelligence service install");
    expect(commandName("start:server", true)).toBe("work-intelligence start");
  });

  it("follows the running mode when none is given (a checkout in tests)", () => {
    expect(commandName("check")).toBe("pnpm check");
  });
});
