import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DatabaseBackupCreated,
  DatabaseBackupUnavailable,
  FolderPickResult,
  ProjectDataExportScope,
  ProjectDataImportPreview,
  ProjectDataImportResult,
  ProjectDataImportStagedHeader,
  ProjectFolderStatus,
  SystemAgentConnections,
  UserServiceStatus,
} from "@work-intelligence/core";
import type { z } from "zod";
import { safeParseStrict, type StrictParseResult } from "@work-intelligence/schema";
import type { ExportOptions, WorkIntelligenceStore } from "@work-intelligence/storage";
import type { McpRuntimeStatus } from "@work-intelligence/shared/mcp-runtime";
import { sendError, sendJson } from "../http.js";
import type { StagedImports } from "../staged-imports.js";

export type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** An import request body saved to disk, and the private transfer directory it is in (its spill file goes there too). */
export interface ProjectDataImportUpload {
  path: string;
  directory: string;
  /** "request" (the default): a REST body `{bundle, ...choices}`. "bundle": a staged export file, choices in `options`. */
  envelope?: "request" | "bundle";
  /** The import choices of a staged file (projectId, remap, strategy); validated with the file. */
  options?: unknown;
}

export type ProjectDataImportPreviewWithFolderStatus = Omit<ProjectDataImportPreview, "selectedProjects"> & {
  selectedProjects: Array<ProjectDataImportPreview["selectedProjects"][number] & { folderStatus: ProjectFolderStatus }>;
};

export interface StagedProjectDataImportInspection {
  header: ProjectDataImportStagedHeader;
  preview: ProjectDataImportPreviewWithFolderStatus;
}

/** Store work that the production server runs away from its request and maintenance event loop. */
export interface BackgroundStoreOperations {
  createBackup(): Promise<DatabaseBackupCreated | DatabaseBackupUnavailable>;
  backupIfDue(): Promise<DatabaseBackupCreated | null>;
  /** `durable: false` for a staging copy that is streamed once and removed; see `ExportOptions` in storage. */
  exportTo(target: string, options?: ExportOptions): Promise<{ bytes: number }>;
  /** Writes the portable export of `scope` to `target`, which must not exist yet, in bounded memory. */
  exportProjectData(scope: ProjectDataExportScope, target: string): Promise<{ bytes: number }>;
  /** Streams and validates the uploaded request, then counts what an import would change. */
  previewProjectDataImport(upload: ProjectDataImportUpload): Promise<ProjectDataImportPreviewWithFolderStatus>;
  /** Streams and validates the uploaded request, backs up and imports; the search index is synced before it resolves. */
  importProjectData(upload: ProjectDataImportUpload): Promise<ProjectDataImportResult>;
  /** Validates a staged export file once: what the import page shows about it and the first preview. */
  inspectStagedProjectDataImport(upload: ProjectDataImportUpload): Promise<StagedProjectDataImportInspection>;
  close(): Promise<void>;
}

/** What the shared server flow hands a route after Host, Origin, and CORS checks have passed. */
export interface RouteServices {
  pickFolder(): Promise<FolderPickResult>;
  startEventStream(response: ServerResponse): void;
  eventClientCount(): number;
  mcpRuntimeStatus(): McpRuntimeStatus;
  agentConnections(): SystemAgentConnections;
  userServiceStatus(): UserServiceStatus | Promise<UserServiceStatus>;
  backgroundStore: BackgroundStoreOperations;
  /** Where large uploads and exports are staged: `tmp` beside the database (see transfer-workspace.ts). */
  transferRoot: string;
  /** Export files saved for an import from the Web UI, referred to by id (see staged-imports.ts). */
  stagedImports: StagedImports;
  /** The health instance proof for this request's challenge header, or undefined when none applies. */
  instanceProof(request: IncomingMessage): string | undefined;
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

interface CompiledRoute {
  route: Route;
  segments: string[];
  rest: boolean;
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Validates REST input strictly: a body field or query parameter the schema does not define fails with 400 and
 * is named in the issues, where zod's default would drop it. Every route parses its input through this; the
 * shared schemas stay as they are, so MCP keeps its own (equally strict) argument check.
 */
export function parseRequestInput<S extends z.ZodType>(schema: S, value: unknown): StrictParseResult<z.output<S>> {
  return safeParseStrict(schema, value);
}

/**
 * The common route shape: build the input from the request, validate it (400 with the flattened issues when it
 * is invalid), and send what the store returns.
 */
export function validatedRoute<S extends z.ZodType>(
  schema: S,
  invalidMessage: string,
  input: (context: RouteContext) => unknown,
  run: (context: RouteContext, data: z.output<S>) => unknown,
  status = 200,
): Route["handler"] {
  return async (context) => {
    const parsed = parseRequestInput(schema, await input(context));
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
