// Checks (and with --fix, applies) the fixed top-level order of `<script setup>` blocks described in the
// worklog-code-layout skill, so every component reads the same way:
//   imports → types → macros → constants → stores/composables → state → computed → functions → watchers
//   → lifecycle → defineExpose
// A composable that takes this component's own state (a template ref, a local ref) as an argument belongs to
// the state section, after the state it uses. Statements that fit no section (plain constants, one-off calls)
// stay attached to the statement before them.
//
// Usage: node scripts/sfc-layout.mjs [--fix] [files...]   (defaults to apps/web/src/**/*.vue)
import { error as logError } from "node:console";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const SECTIONS = [
  "imports",
  "types",
  "macros",
  "composables",
  "state",
  "computed",
  "functions",
  "watchers",
  "lifecycle",
  "expose",
];

const MACROS = new Set(["defineProps", "defineEmits", "defineModel", "defineSlots", "defineOptions", "withDefaults"]);
const STATE = new Set(["ref", "reactive", "shallowRef", "shallowReactive", "useTemplateRef", "customRef"]);
const WATCHERS = new Set(["watch", "watchEffect", "watchPostEffect", "watchSyncEffect"]);

function calleeName(expression) {
  let node = expression;
  while (node && ts.isAsExpression(node)) node = node.expression;
  if (!node || !ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

/** The section of one top-level statement, or undefined for plain constants and other statements. */
export function sectionOf(statement) {
  if (ts.isImportDeclaration(statement)) return "imports";
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return "types";
  if (ts.isFunctionDeclaration(statement)) return "functions";
  let name;
  if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations[0];
    name = declaration?.initializer ? calleeName(declaration.initializer) : undefined;
  } else if (ts.isExpressionStatement(statement)) {
    name = calleeName(statement.expression);
  }
  if (!name) return undefined;
  if (name === "defineExpose") return "expose";
  if (MACROS.has(name)) return "macros";
  if (STATE.has(name)) return "state";
  if (name === "computed") return "computed";
  if (WATCHERS.has(name)) return "watchers";
  if (/^on[A-Z]/.test(name)) return "lifecycle";
  if (name === "storeToRefs" || /^use[A-Z]/.test(name)) return "composables";
  return undefined;
}

function scriptSetup(source) {
  const match = /<script\s+setup[^>]*>([\s\S]*?)<\/script>/.exec(source);
  return match ? { code: match[1], start: match.index + match[0].indexOf(match[1]) } : undefined;
}

function declaredNames(statement) {
  if (!ts.isVariableStatement(statement)) return [];
  const names = [];
  const collect = (name) => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) collect(element.name);
  };
  for (const declaration of statement.declarationList.declarations) collect(declaration.name);
  return names;
}

function referencesAny(node, names) {
  if (ts.isIdentifier(node) && names.has(node.text)) return true;
  return ts.forEachChild(node, (child) => referencesAny(child, names)) ?? false;
}

/** Top-level statements with the section each one belongs to (plain statements inherit the previous section). */
function classify(code) {
  const file = ts.createSourceFile("setup.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stateNames = new Set(
    file.statements.filter((statement) => sectionOf(statement) === "state").flatMap(declaredNames),
  );
  let inherited = -1;
  return file.statements.map((statement) => {
    let own = sectionOf(statement);
    if (own === "composables" && referencesAny(statement, stateNames)) own = "state";
    const rank = own ? SECTIONS.indexOf(own) : Math.max(inherited, 1);
    if (own) inherited = rank;
    return { statement, rank, section: own ?? "(attached)", full: statement.getFullStart(), end: statement.getEnd() };
  });
}

/** Out-of-order statements: each one ranks below a statement before it. */
export function layoutProblems(source) {
  const setup = scriptSetup(source);
  if (!setup) return [];
  const problems = [];
  let highest = -1;
  let highestSection = "";
  for (const item of classify(setup.code)) {
    if (item.section !== "(attached)" && item.rank < highest) {
      problems.push(`${item.section} after ${highestSection}: ${item.statement.getText().split("\n")[0].slice(0, 80)}`);
    }
    if (item.rank > highest) {
      highest = item.rank;
      highestSection = SECTIONS[item.rank];
    }
  }
  return problems;
}

/** Stable-sorts the statements by section, carrying each statement's leading comments with it. */
export function fixLayout(source) {
  const setup = scriptSetup(source);
  if (!setup || layoutProblems(source).length === 0) return source;
  const items = classify(setup.code);
  const head = setup.code.slice(0, items[0].full) + (/^\n+/.exec(setup.code.slice(items[0].full))?.[0] ?? "");
  const tail = setup.code.slice(items[items.length - 1].end);
  const chunks = items.map((item, index) => ({ ...item, index, text: setup.code.slice(item.full, item.end) }));
  const sorted = [...chunks].sort((left, right) => left.rank - right.rank || left.index - right.index);
  const body = sorted
    .map((chunk, position) => {
      const text = chunk.text.replace(/^\n+/, "");
      // Keep one blank line between sections, and the original spacing inside a section.
      const previous = sorted[position - 1];
      if (!previous) return text;
      const separator = previous.rank !== chunk.rank ? "\n\n" : /^\n\s*\n/.test(chunk.text) ? "\n\n" : "\n";
      return separator + text;
    })
    .join("");
  const code = head + body + tail;
  return source.slice(0, setup.start) + code + source.slice(setup.start + setup.code.length);
}

function vueFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? vueFiles(path) : path.endsWith(".vue") ? [path] : [];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fix = process.argv.includes("--fix");
  const targets = process.argv.slice(2).filter((argument) => argument !== "--fix");
  const files = targets.length > 0 ? targets : vueFiles("apps/web/src");
  let failing = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (fix) {
      const fixed = fixLayout(source);
      if (fixed !== source) writeFileSync(file, fixed);
      continue;
    }
    const problems = layoutProblems(source);
    if (problems.length > 0) {
      failing += 1;
      logError(`${relative(process.cwd(), file)}\n  ${problems.join("\n  ")}`);
    }
  }
  if (!fix && failing > 0) {
    logError(`\n${failing} file(s) break the <script setup> layout. Run: node scripts/sfc-layout.mjs --fix`);
    process.exitCode = 1;
  }
}
