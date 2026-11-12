import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../../apps/server/src/routes/index.js";

const REST_DOC = readFileSync(fileURLToPath(new URL("../../docs/rest-api.md", import.meta.url)), "utf8");
const TABLE_ROUTE = /^\|\s*([A-Z/]+)\s*\|\s*`(\/api\/[^`\s]*)`/gm;
const INLINE_ROUTE = /\b(GET|POST|PATCH|DELETE) `?(\/api\/[^`\s，。、；（）()]*)/g;
const BARE_PATH = /`(\/api\/[^`\s]*)`/g;

/** `/api/sessions/:sessionId?x=1` and `/api/sessions/:id` name the same route. */
function normalizePath(path: string): string {
  return path
    .replace(/[?#].*$/, "")
    .replace(/:\w+\*?/g, ":")
    .replace(/\/$/, "");
}

/** Routes the document names with a method: route-table rows ("GET/POST") and inline `METHOD /api/...` mentions. */
function documentedRoutes(document: string): Set<string> {
  const found = new Set<string>();
  for (const [, methods, path] of document.matchAll(TABLE_ROUTE)) {
    for (const method of methods!.split("/")) found.add(`${method} ${normalizePath(path!)}`);
  }
  for (const [, method, path] of document.matchAll(INLINE_ROUTE)) {
    found.add(`${method} ${normalizePath(path!)}`);
  }
  return found;
}

describe("REST API documentation", () => {
  const registered = new Set(apiRoutes.map((route) => `${route.method} ${normalizePath(route.pattern)}`));
  const documented = documentedRoutes(REST_DOC);

  it("documents every registered route", () => {
    expect([...registered].filter((route) => !documented.has(route)).sort()).toEqual([]);
  });

  it("names no route that does not exist", () => {
    expect([...documented].filter((route) => !registered.has(route)).sort()).toEqual([]);
    const registeredPaths = new Set([...registered].map((route) => route.split(" ")[1]));
    const bare = [...REST_DOC.matchAll(BARE_PATH)].map((match) => normalizePath(match[1]!));
    expect(bare.filter((path) => !registeredPaths.has(path))).toEqual([]);
  });
});
