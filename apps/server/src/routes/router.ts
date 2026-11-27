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
  SystemDesktopStatus,
  UserServiceStatus,
} from "@work-intelligence/core";
import type { z } from "zod";
import {
  safeParseStrict,
  type DesktopFacts,
  type StrictParseResult,
  flattenInputError,
} from "@work-intelligence/schema";
import type { ExportOptions, WorkIntelligenceStore } from "@work-intelligence/storage";
import type { McpLeaseDiagnosis } from "@work-intelligence/shared/agent-observations";
import type { McpRuntimeStatus } from "@work-intelligence/shared/mcp-runtime";
import { sendError, sendJson } from "../http.js";
import type { StagedImports } from "../staged-imports.js";
import type { UsageOperations } from "../usage-scan.js";

export type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ProjectDataImportUpload {
  path: string;
  directory: string;
  envelope?: "request" | "bundle";
  options?: unknown;
}

export type ProjectDataImportPreviewWithFolderStatus = Omit<ProjectDataImportPreview, "selectedProjects"> & {
  selectedProjects: Array<ProjectDataImportPreview["selectedProjects"][number] & { folderStatus: ProjectFolderStatus }>;
};

export interface StagedProjectDataImportInspection {
  header: ProjectDataImportStagedHeader;
  preview: ProjectDataImportPreviewWithFolderStatus;
}

export interface BackgroundStoreOperations {
  createBackup(): Promise<DatabaseBackupCreated | DatabaseBackupUnavailable>;
  backupIfDue(): Promise<DatabaseBackupCreated | null>;
  exportTo(target: string, options?: ExportOptions): Promise<{ bytes: number }>;
  exportProjectData(scope: ProjectDataExportScope, target: string, maxBytes?: number): Promise<{ bytes: number }>;
  previewProjectDataImport(upload: ProjectDataImportUpload): Promise<ProjectDataImportPreviewWithFolderStatus>;
  importProjectData(upload: ProjectDataImportUpload): Promise<ProjectDataImportResult>;
  inspectStagedProjectDataImport(upload: ProjectDataImportUpload): Promise<StagedProjectDataImportInspection>;
  close(): Promise<void>;
}

export type ShellLocale = NonNullable<DesktopFacts["language"]>["locale"];

export interface DesktopRouteServices {
  status: SystemDesktopStatus;
  requestOpenAgentSetup(): void;
  requestOpenPortSettings(handoff: { preferences?: unknown; route?: string }): void;
  requestSetLanguage(locale: ShellLocale): void;
}

export interface RouteServices {
  pickFolder(): Promise<FolderPickResult>;
  startEventStream(response: ServerResponse): void;
  eventClientCount(): number;
  mcpRuntimeStatus(): McpRuntimeStatus;
  mcpLeaseDiagnosis(activeLeases: number): McpLeaseDiagnosis;
  agentConnections(): SystemAgentConnections;
  userServiceStatus(): UserServiceStatus | Promise<UserServiceStatus>;
  desktop?: DesktopRouteServices;
  backgroundStore: BackgroundStoreOperations;
  usage: UsageOperations;
  transferRoot: string;
  stagedImports: StagedImports;
  instanceProof(request: IncomingMessage): string | undefined;
}

export interface RouteContext {
  store: WorkIntelligenceStore;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  /** Exactly as they appear in the URL, not percent-decoded. */
  params: Readonly<Record<string, string>>;
  services: RouteServices;
}

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

export function parseRequestInput<S extends z.ZodType>(schema: S, value: unknown): StrictParseResult<z.output<S>> {
  return safeParseStrict(schema, value);
}

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
      sendError(context.response, 400, invalidMessage, flattenInputError(parsed.error));
      return;
    }
    sendJson(context.response, status, run(context, parsed.data));
  };
}

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
