import { describe, expect, it } from "vitest";
import { MINIMUM_NODE_VERSION } from "../../packages/shared/src/index.js";
import { MINIMUM_NODE, runBootstrap, type BootstrapDependencies } from "../../scripts/bootstrap.mjs";

interface Harness {
  dependencies: BootstrapDependencies;
  steps: string[];
  output: string[];
  errors: string[];
  questions: string[];
}

function createHarness(
  overrides: Partial<BootstrapDependencies> = {},
  options: { answers?: string[]; failing?: string[] } = {},
): Harness {
  const steps: string[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
  const dependencies: BootstrapDependencies = {
    nodeVersion: "24.0.0",
    pnpmVersion: () => "11.16.0",
    requiredPnpm: "11.16.0",
    interactive: true,
    serviceInstalled: async () => false,
    log: (message) => output.push(message),
    error: (message) => errors.push(message),
    ask: async (question) => {
      questions.push(question);
      return answers.shift() ?? "";
    },
    runStep: (args) => {
      const command = args.join(" ");
      steps.push(command);
      return options.failing?.includes(command) ? 1 : 0;
    },
    ...overrides,
  };
  return { dependencies, steps, output, errors, questions };
}

describe("pnpm bootstrap", () => {
  it("keeps the script's Node.js minimum in step with the shared constant", () => {
    expect(MINIMUM_NODE).toBe(MINIMUM_NODE_VERSION);
  });

  it("runs install, build, setup:agents and doctor in order after one confirmation", async () => {
    const harness = createHarness({}, { answers: ["", "n"] });
    expect(await runBootstrap([], harness.dependencies)).toBe(0);
    expect(harness.steps).toEqual(["install", "build", "setup:agents", "run doctor"]);
    expect(harness.questions).toHaveLength(2);
    expect(harness.output.join("\n")).toContain("pnpm start");
  });

  it("stops before running anything when Node.js is too old", async () => {
    const harness = createHarness({ nodeVersion: "22.12.0" });
    expect(await runBootstrap(["--yes"], harness.dependencies)).toBe(1);
    expect(harness.steps).toEqual([]);
    expect(harness.errors.join("\n")).toContain(MINIMUM_NODE);
  });

  it("stops when pnpm is older than the repository requires", async () => {
    const harness = createHarness({ pnpmVersion: () => "10.0.0" });
    expect(await runBootstrap(["--yes"], harness.dependencies)).toBe(1);
    expect(harness.steps).toEqual([]);
  });

  it("runs nothing when the interactive confirmation is declined", async () => {
    const harness = createHarness({}, { answers: ["n"] });
    expect(await runBootstrap([], harness.dependencies)).toBe(0);
    expect(harness.steps).toEqual([]);
  });

  it("only prints the plan in a non-interactive terminal without --yes", async () => {
    const harness = createHarness({ interactive: false });
    expect(await runBootstrap([], harness.dependencies)).toBe(0);
    expect(harness.steps).toEqual([]);
    expect(harness.questions).toEqual([]);
    expect(harness.output.join("\n")).toContain("--yes");
  });

  it("runs non-interactively with --yes and skips the service without asking", async () => {
    const harness = createHarness({ interactive: false });
    expect(await runBootstrap(["--yes"], harness.dependencies)).toBe(0);
    expect(harness.steps).toEqual(["install", "build", "setup:agents", "run doctor"]);
    expect(harness.questions).toEqual([]);
  });

  it("skips connecting Agents with --skip-agents", async () => {
    const harness = createHarness({}, { answers: ["", "n"] });
    expect(await runBootstrap(["--skip-agents"], harness.dependencies)).toBe(0);
    expect(harness.steps).toEqual(["install", "build", "run doctor"]);
  });

  it("stops at a failed build and runs nothing after it", async () => {
    const harness = createHarness({}, { answers: [""], failing: ["build"] });
    expect(await runBootstrap([], harness.dependencies)).toBe(1);
    expect(harness.steps).toEqual(["install", "build"]);
    expect(harness.errors.join("\n")).toContain("pnpm bootstrap");
  });

  it("installs the login service only after a yes answer or --service", async () => {
    const declined = createHarness({}, { answers: ["", "n"] });
    await runBootstrap([], declined.dependencies);
    expect(declined.steps).not.toContain("service:install");

    const accepted = createHarness({}, { answers: ["", "y"] });
    await runBootstrap([], accepted.dependencies);
    expect(accepted.steps).toEqual(["install", "build", "setup:agents", "service:install", "run doctor"]);

    const flagged = createHarness({ interactive: false });
    await runBootstrap(["--yes", "--service"], flagged.dependencies);
    expect(flagged.steps).toEqual(["install", "build", "setup:agents", "service:install", "run doctor"]);
    expect(flagged.questions).toEqual([]);
  });

  it("does not ask about the login service when it is already installed and reminds to restart it", async () => {
    const harness = createHarness({ serviceInstalled: async () => true }, { answers: [""] });
    expect(await runBootstrap([], harness.dependencies)).toBe(0);
    expect(harness.steps).toEqual(["install", "build", "setup:agents", "run doctor"]);
    expect(harness.questions).toHaveLength(1);
    expect(harness.output.join(" ")).toContain("pnpm service:install 重啟服務");

    const quiet = createHarness({ interactive: false, serviceInstalled: async () => true });
    await runBootstrap(["--yes"], quiet.dependencies);
    expect(quiet.steps).not.toContain("service:install");
    expect(quiet.output.join(" ")).toContain("pnpm service:install 重啟服務");
  });

  it("still runs the service step with --service even when it is already installed", async () => {
    const harness = createHarness({ interactive: false, serviceInstalled: async () => true });
    await runBootstrap(["--yes", "--service"], harness.dependencies);
    expect(harness.steps).toContain("service:install");
  });

  it("does not fail when doctor reports a problem", async () => {
    const harness = createHarness({ interactive: false }, { failing: ["run doctor"] });
    expect(await runBootstrap(["--yes"], harness.dependencies)).toBe(0);
    expect(harness.steps.at(-1)).toBe("run doctor");
  });

  it("rejects unknown flags with usage and exit code 2", async () => {
    const harness = createHarness();
    expect(await runBootstrap(["--bogus"], harness.dependencies)).toBe(2);
    expect(harness.steps).toEqual([]);
    expect(harness.errors.join("\n")).toContain("用法");
  });

  it("prints usage for --help without running anything", async () => {
    const harness = createHarness();
    expect(await runBootstrap(["--help"], harness.dependencies)).toBe(0);
    expect(harness.steps).toEqual([]);
    expect(harness.output.join("\n")).toContain("--skip-agents");
  });
});
