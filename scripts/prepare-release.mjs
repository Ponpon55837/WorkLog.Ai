import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function extractReleaseNotes(tag, packageVersion, changelog) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    throw new Error("Release tag must start with v.");
  }

  const version = tag.slice(1);
  if (!semanticVersionPattern.test(version) || packageVersion !== version) {
    throw new Error(`Tag ${tag} must match the root package.json version (${packageVersion}).`);
  }

  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const headingIndexes = lines.flatMap((line, index) => {
    const heading = line.match(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/);
    return heading?.[1] === version ? [index] : [];
  });

  if (headingIndexes.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one dated heading for [${version}].`);
  }

  const headingIndex = headingIndexes[0];
  const nextHeadingIndex = lines.findIndex((line, index) => index > headingIndex && /^##\s/.test(line));
  const notes = lines
    .slice(headingIndex + 1, nextHeadingIndex === -1 ? undefined : nextHeadingIndex)
    .join("\n")
    .trim();
  if (!notes) {
    throw new Error(`CHANGELOG.md release section [${version}] is empty.`);
  }

  return { version, notes };
}

function main() {
  const tag = process.env.GITHUB_REF_NAME;
  const packagePath = resolve(process.env.RELEASE_PACKAGE_JSON ?? join(repositoryRoot, "package.json"));
  const changelogPath = resolve(process.env.RELEASE_CHANGELOG ?? join(repositoryRoot, "CHANGELOG.md"));
  const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
  const changelog = readFileSync(changelogPath, "utf8");
  const { version, notes } = extractReleaseNotes(tag, packageMetadata.version, changelog);
  const runnerTemp = resolve(process.env.RUNNER_TEMP ?? tmpdir());
  const outputPath = process.env.GITHUB_OUTPUT;

  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required to pass release metadata to later workflow steps.");
  }

  mkdirSync(runnerTemp, { recursive: true });
  const notesPath = join(runnerTemp, `work-intelligence-release-notes-${version}.md`);
  writeFileSync(notesPath, `${notes}\n`, "utf8");
  appendFileSync(outputPath, `version=${version}\nrelease_notes_file=${notesPath}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
