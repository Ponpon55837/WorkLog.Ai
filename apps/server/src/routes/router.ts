import type { IncomingMessage, ServerResponse } from "node:http";
import type { FolderPickResult, SystemAgentConnections } from "@work-intelligence/core";
import type { WorkIntelligenceStore } from "@work-intelligence/storage";
import type { McpRuntimeStatus } from "@work-intelligence/shared/mcp-runtime";
import { sendError, sendJson } from "../http.js";

export type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** What the shared server flow hands a route after Host, Origin, and CORS checks have passed. */
export interface RouteServices {
  pickFolder(): Promise<FolderPickResult>;
  startEventStream(response: ServerResponse): void;
  eventClientCount(): number;
  mcpRuntimeStatus(): McpRuntimeStatus;
  agentConnections(): SystemAgentConnections;
}

export interface RouteContext {
  store: WorkIntelligenceStore;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  /** Path parameters exactly as they appear in the URL (not percent-decoded), like the server always passed them. */
  params: Readonly<Record<string, string>>;
  services: RouteServices;
}

/**
 * One API route. `pattern` segments are literals, `:name` (one non-empty segment), or a final `:name*` (the rest
 * of the path, one or more segments).
 */
export interface Route {
  method: RouteMethod;
  pattern: string;
  handler(context: RouteContext): Promise<void> | void;
}

/** Any schema with zod's safeParse shape; the server does not need zod itself. */
interface Validator<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } };
}

interface CompiledRoute {
  route: Route;
  segments: string[];
  rest: boolean;
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * The common route shape: build the input from the request, validate it (400 with the flattened issues when it
 * is invalid), and send what the store returns.
 */
export function validatedRoute<T>(
  schema: Validator<T>,
  invalidMessage: string,
  input: (context: RouteContext) => unknown,
  run: (context: RouteContext, data: T) => unknown,
  status = 200,
): Route["handler"] {
  return async (context) => {
    const parsed = schema.safeParse(await input(context));
    if (!parsed.success) {
      sendError(context.response, 400, invalidMessage, parsed.error.flatten());
      return;
    }
    sendJson(context.response, status, run(context, parsed.data));
  };
}

/**
 * Matches requests to routes: literal paths through a hash map in O(1), parameterized paths grouped by method and
 * segment count. A literal path always wins over a parameterized one, and the table rejects duplicates.
 */
export class Router {
  private readonly literal = new Map<string, Route>();
  private readonly parameterized = new Map<string, CompiledRoute[]>();
  private readonly withRest: CompiledRoute[] = [];

  public constructor(routes: readonly Route[]) {
    const seen = new Set<string>();
    for (const route of routes) {
      const key = `${route.method} ${route.pattern}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate API route: ${key}`);
      }
      seen.add(key);
      const segments = splitPath(route.pattern);
      const rest = segments.at(-1)?.endsWith("*") ?? false;
      if (rest) {
        this.withRest.push({ route, segments, rest });
      } else if (segments.some((segment) => segment.startsWith(":"))) {
        const group = `${route.method} ${segments.length}`;
        this.parameterized.set(group, [...(this.parameterized.get(group) ?? []), { route, segments, rest }]);
      } else {
        this.literal.set(`${route.method} /${segments.join("/")}`, route);
      }
    }
  }

  public match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = splitPath(pathname);
    const literal = this.literal.get(`${method} /${parts.join("/")}`);
    if (literal) {
      return { route: literal, params: {} };
    }
    for (const candidate of [...(this.parameterized.get(`${method} ${parts.length}`) ?? []), ...this.withRest]) {
      if (candidate.route.method !== method) continue;
      const params = this.bind(candidate, parts);
      if (params) {
        return { route: candidate.route, params };
      }
    }
    return undefined;
  }

  private bind(candidate: CompiledRoute, parts: readonly string[]): Record<string, string> | undefined {
    const { segments, rest } = candidate;
    if (rest ? parts.length < segments.length : parts.length !== segments.length) {
      return undefined;
    }
    const params: Record<string, string> = {};
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (rest && index === segments.length - 1) {
        params[segment.slice(1, -1)] = parts.slice(index).join("/");
      } else if (segment.startsWith(":")) {
        params[segment.slice(1)] = parts[index]!;
      } else if (segment !== parts[index]) {
        return undefined;
      }
    }
    return params;
  }
}
