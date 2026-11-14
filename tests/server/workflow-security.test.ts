import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDirectory = join(repositoryRoot, ".github", "workflows");

// Checkout steps that legitimately keep credentials (they must push). Format: "<file>:<job id>". Currently none:
// the release create-tag job passes the token to git through its environment instead.
const persistCredentialsAllowList = new Set<string>();

interface Job {
  id: string;
  lines: string[];
}

function readWorkflows(): { file: string; text: string }[] {
  return readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((file) => ({ file, text: readFileSync(join(workflowDirectory, file), "utf8") }));
}

// Text scan: job ids are the two-space-indented keys under the top-level `jobs:` key.
function splitJobs(text: string): Job[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  if (start === -1) {
    return [];
  }

  const jobs: Job[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      jobs.push({ id: header[1], lines: [] });
    } else if (jobs.length > 0) {
      jobs[jobs.length - 1].lines.push(line);
    }
  }
  return jobs;
}

// Each checkout step's text: from its `uses:` line to the next step (`- ` at the same indent) or the end of the job.
function checkoutSteps(job: Job): string[] {
  const steps: string[] = [];
  for (let index = 0; index < job.lines.length; index += 1) {
    const match = job.lines[index].match(/^(\s*)(?:- )?uses:\s*actions\/checkout@/);
    if (!match) {
      continue;
    }
    const block = [job.lines[index]];
    for (let next = index + 1; next < job.lines.length; next += 1) {
      if (/^\s*- /.test(job.lines[next]) && job.lines[next].search(/\S/) <= job.lines[index].search(/\S/)) {
        break;
      }
      block.push(job.lines[next]);
    }
    steps.push(block.join("\n"));
  }
  return steps;
}

describe("workflow supply-chain hardening", () => {
  const workflows = readWorkflows();

  it("finds the CI and release workflows", () => {
    expect(workflows.map((workflow) => workflow.file)).toEqual(expect.arrayContaining(["ci.yml", "release.yml"]));
  });

  it("pins every remote action to a full commit SHA with a version comment", () => {
    const violations: string[] = [];
    for (const { file, text } of workflows) {
      text.split("\n").forEach((line, index) => {
        const match = line.match(/^\s*(?:- )?uses:\s*(\S+)(.*)$/);
        if (!match || match[1].startsWith("./")) {
          return;
        }
        if (!/^[^@\s]+@[0-9a-f]{40}$/.test(match[1]) || !/^\s+# v\d/.test(match[2])) {
          violations.push(`${file}:${index + 1} ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("disables persisted credentials on every checkout unless explicitly allowed", () => {
    const violations: string[] = [];
    for (const { file, text } of workflows) {
      for (const job of splitJobs(text)) {
        if (persistCredentialsAllowList.has(`${file}:${job.id}`)) {
          continue;
        }
        for (const step of checkoutSteps(job)) {
          if (!/^\s*persist-credentials:\s*false\s*$/m.test(step)) {
            violations.push(`${file}:${job.id}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the publish job free of dependency caches", () => {
    const release = workflows.find((workflow) => workflow.file === "release.yml");
    const publish = splitJobs(release?.text ?? "").find((job) => job.id === "publish");

    expect(publish).toBeDefined();
    const publishText = publish!.lines.join("\n");
    expect(publishText).toContain("actions/setup-node@");
    expect(publishText).not.toMatch(/^\s*cache(-dependency-path)?:/m);
    expect(publishText).not.toContain("actions/cache");
  });

  it("never interpolates the manual release input inside a run script", () => {
    const release = workflows.find((workflow) => workflow.file === "release.yml")!.text;
    const violations: string[] = [];
    let inRun = false;
    let runIndent = 0;
    for (const line of release.split("\n")) {
      const run = line.match(/^(\s*)(?:- )?run:/);
      if (run) {
        inRun = true;
        runIndent = run[1].length;
        if (/\$\{\{\s*inputs\./.test(line)) {
          violations.push(line.trim());
        }
      } else if (inRun && line.trim() !== "" && line.search(/\S/) <= runIndent) {
        inRun = false;
      } else if (inRun && /\$\{\{\s*(inputs|github\.event\.inputs)\./.test(line)) {
        violations.push(line.trim());
      }
    }
    expect(violations).toEqual([]);
  });
});
