import console from "node:console";
import process from "node:process";
import { runPnpm } from "./run-pnpm.mjs";

const projects = ["chromium", "firefox", "webkit"];
// The browser regression suite builds its fixtures once in beforeAll, so Playwright cannot retry a test in place.
// On CI a failed project is run once more from the start; each run gets a fresh server and SQLite database.
const attempts = process.env.CI ? 2 : 1;
// Extra arguments (for example `-g <title>`) are passed to every Playwright run.
const extraArgs = process.argv.slice(2);

function runProject(project, attempt) {
  const output = attempt === 1 ? `test-results/${project}` : `test-results/${project}-rerun-${attempt}`;
  const result = runPnpm(["exec", "playwright", "test", `--project=${project}`, `--output=${output}`, ...extraArgs], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}

for (const project of projects) {
  let passed = false;
  for (let attempt = 1; attempt <= attempts && !passed; attempt += 1) {
    if (attempt > 1) {
      console.log(`\n${project} failed; running it again with a fresh server and database (attempt ${attempt}).\n`);
    }
    passed = runProject(project, attempt);
    if (passed && attempt > 1) {
      // Keep flaky runs visible on the workflow summary even though the job passes.
      console.log(`::warning title=Flaky E2E::${project} passed only after a full rerun; see test-results/${project}.`);
    }
  }
  if (!passed) {
    process.exit(1);
  }
}
