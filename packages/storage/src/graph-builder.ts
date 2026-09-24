import { DatabaseSync } from "node:sqlite";
import type {
  GraphEdge,
  GraphNode,
  GraphNodeTotals,
  GraphQuery,
  GraphQueryResult,
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeStatus,
  PolicyDecision,
  ProjectRecord,
  WorkSessionRecord,
} from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";
import type { SessionRow } from "./session-repository.js";

type GraphKnowledgeRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  session_id: string | null;
  idempotency_key: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags_json: string;
  references_json: string;
  status: KnowledgeStatus;
  created_at: string;
  updated_at: string;
};

type GraphEvidenceRow = {
  id: string;
  session_id: string;
  project_id: string;
  kind: string;
  reference: string;
  summary: string | null;
  captured_at: string;
  session_title: string;
  project_name: string | null;
};

interface GraphBuilderDependencies {
  listProjects(): ProjectRecord[];
  getProjectById(projectId: string): ProjectRecord | undefined;
  checkProjectRoot(projectRoot: string): PolicyDecision;
  checkProjectById(projectId: string): PolicyDecision;
  toSession(row: SessionRow): WorkSessionRecord;
  toKnowledge(row: GraphKnowledgeRow): KnowledgeRecord;
}

const GRAPH_CURSOR_VERSION = 2;

type GraphCursorPhase = "projects" | "sessions" | "project_knowledge";

interface DecodedGraphCursor {
  version: number;
  phase: GraphCursorPhase;
  projectOffset: number;
  sessionOffset: number;
  relationOffset: number;
  scope: string;
}

function graphCursorScope(options: GraphQuery): string {
  return JSON.stringify([options.projectRoot ?? "", options.projectId ?? ""]);
}

function encodeGraphCursor(cursor: Omit<DecodedGraphCursor, "version" | "scope">, scope: string): string {
  return Buffer.from(JSON.stringify({ version: GRAPH_CURSOR_VERSION, ...cursor, scope }), "utf8").toString("base64url");
}

function decodeGraphCursor(value: string | undefined, scope: string): DecodedGraphCursor | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<DecodedGraphCursor>;
    if (
      parsed.version !== GRAPH_CURSOR_VERSION ||
      parsed.scope !== scope ||
      !parsed.phase ||
      !["projects", "sessions", "project_knowledge"].includes(parsed.phase) ||
      typeof parsed.projectOffset !== "number" ||
      !Number.isInteger(parsed.projectOffset) ||
      parsed.projectOffset < 0 ||
      typeof parsed.sessionOffset !== "number" ||
      !Number.isInteger(parsed.sessionOffset) ||
      parsed.sessionOffset < 0 ||
      typeof parsed.relationOffset !== "number" ||
      !Number.isInteger(parsed.relationOffset) ||
      parsed.relationOffset < 0
    ) {
      return undefined;
    }
    return parsed as DecodedGraphCursor;
  } catch {
    return undefined;
  }
}

/** Deterministic graph query and bounded node/edge materialization. */
export class GraphBuilder {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: GraphBuilderDependencies,
  ) {}

  public build(options: GraphQuery = {}): GraphQueryResult {
    let scopedProject: ProjectRecord | undefined;
    let projectId = options.projectId;
    const cursorRequested = options.cursor !== undefined || options.pageSize !== undefined;
    const cursorScope = graphCursorScope(options);
    const decodedCursor = decodeGraphCursor(options.cursor, cursorScope);

    if (options.projectRoot) {
      const decision = this.dependencies.checkProjectRoot(options.projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      if (projectId && projectId !== decision.project.id) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: "Project scope does not match projectRoot.",
        };
      }
      scopedProject = decision.project;
      projectId = decision.project.id;
    }

    if (projectId) {
      const project = this.dependencies.getProjectById(projectId);
      if (!project) {
        return {
          outcome: "graph",
          projects: [],
          nodes: [],
          edges: [],
          totalNodes: 0,
          totalEdges: 0,
          totalNodesByKind: { project: 0, session: 0, knowledge: 0, evidence: 0, file: 0 },
          sourceProjectIds: [],
          sourceSessionIds: [],
          truncation: {
            nodeLimit: Math.min(Math.max(options.maxNodes ?? 180, 1), 500),
            edgeLimit: Math.min(Math.max(options.maxEdges ?? 360, 1), 1_000),
            nodesTruncated: false,
            edgesTruncated: false,
          },
        };
      }
      const decision = this.dependencies.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      scopedProject = decision.project;
    }

    const projects = scopedProject
      ? [scopedProject]
      : this.dependencies.listProjects().filter((project) => project.status === "tracked");
    const projectScopeClause = scopedProject ? "AND p.id = ?" : "";
    const projectScopeParameters = scopedProject ? [scopedProject.id] : [];
    const allSessionsForCounts = projects.length
      ? (
          this.db
            .prepare(
              `SELECT s.*, p.name AS project_name
             FROM sessions s
             JOIN projects p ON p.id = s.project_id
             WHERE p.status = 'tracked'
               AND s.voided_at IS NULL
               ${projectScopeClause}
             ORDER BY s.completed_at DESC, s.id DESC`,
            )
            .all(...projectScopeParameters) as SessionRow[]
        ).map(this.dependencies.toSession)
      : [];
    const knowledgeRows = projects.length
      ? (
          this.db
            .prepare(
              `SELECT k.*, p.name AS project_name
             FROM knowledge k
             JOIN projects p ON p.id = k.project_id
             WHERE p.status = 'tracked'
               AND k.status = 'active'
               ${projectScopeClause}
             ORDER BY k.updated_at DESC, k.id DESC`,
            )
            .all(...projectScopeParameters) as GraphKnowledgeRow[]
        ).map(this.dependencies.toKnowledge)
      : [];
    const evidenceRows = projects.length
      ? (this.db
          .prepare(
            `SELECT e.*, s.title AS session_title, p.name AS project_name
             FROM evidence e
             JOIN sessions s ON s.id = e.session_id
             JOIN projects p ON p.id = s.project_id
             WHERE p.status = 'tracked'
               AND s.voided_at IS NULL
               AND e.voided_at IS NULL
               ${projectScopeClause}
             ORDER BY e.captured_at ASC, e.id ASC`,
          )
          .all(...projectScopeParameters) as GraphEvidenceRow[])
      : [];

    const sessionLimit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const sessionWindow = allSessionsForCounts;
    const sessionsByProject = new Map<string, WorkSessionRecord[]>();
    for (const session of sessionWindow) {
      const sessions = sessionsByProject.get(session.projectId) ?? [];
      sessions.push(session);
      sessionsByProject.set(session.projectId, sessions);
    }
    const knowledgeByProject = new Map<string, KnowledgeRecord[]>();
    for (const item of knowledgeRows) {
      const items = knowledgeByProject.get(item.projectId) ?? [];
      items.push(item);
      knowledgeByProject.set(item.projectId, items);
    }
    const evidenceBySession = new Map<string, GraphEvidenceRow[]>();
    for (const item of evidenceRows) {
      const items = evidenceBySession.get(item.session_id) ?? [];
      items.push(item);
      evidenceBySession.set(item.session_id, items);
    }
    const fileNodeIds = new Set(
      allSessionsForCounts.flatMap((session) =>
        session.changedFiles.map((file) => `file:${session.projectId}:${file}`),
      ),
    );
    const knowledgeCount = knowledgeRows.length;
    const evidenceCount = evidenceRows.length;
    const totalNodes =
      projects.length + allSessionsForCounts.length + fileNodeIds.size + knowledgeCount + evidenceCount;
    const totalNodesByKind: GraphNodeTotals = {
      project: projects.length,
      session: allSessionsForCounts.length,
      knowledge: knowledgeCount,
      evidence: evidenceCount,
      file: fileNodeIds.size,
    };
    const totalEdges =
      allSessionsForCounts.length +
      allSessionsForCounts.reduce((total, session) => total + session.changedFiles.length, 0) +
      knowledgeCount +
      evidenceCount;
    const nodeLimit = Math.min(
      Math.max(cursorRequested ? (options.pageSize ?? options.maxNodes ?? 180) : (options.maxNodes ?? 180), 1),
      500,
    );
    const edgeLimit = Math.min(Math.max(options.maxEdges ?? 360, 1), 1_000);

    if (cursorRequested) {
      const knowledgeBySession = new Map<string, KnowledgeRecord[]>();
      const knownSessionIds = new Set(allSessionsForCounts.map((session) => session.id));
      const projectKnowledge = knowledgeRows.filter((item) => !item.sessionId || !knownSessionIds.has(item.sessionId));
      for (const item of knowledgeRows) {
        if (!item.sessionId || !knownSessionIds.has(item.sessionId)) {
          continue;
        }
        const items = knowledgeBySession.get(item.sessionId) ?? [];
        items.push(item);
        knowledgeBySession.set(item.sessionId, items);
      }

      const evidenceBySession = new Map<string, GraphEvidenceRow[]>();
      for (const item of evidenceRows) {
        const items = evidenceBySession.get(item.session_id) ?? [];
        items.push(item);
        evidenceBySession.set(item.session_id, items);
      }

      const pageStartSessionOffset = Math.min(decodedCursor?.sessionOffset ?? 0, allSessionsForCounts.length);
      let phase: GraphCursorPhase = decodedCursor?.phase ?? "projects";
      let projectOffset = Math.min(decodedCursor?.projectOffset ?? 0, projects.length);
      let sessionOffset = pageStartSessionOffset;
      let relationOffset = Math.max(decodedCursor?.relationOffset ?? 0, 0);
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const nodeIds = new Set<string>();
      const edgeIds = new Set<string>();
      const sourceSessionIds: string[] = [];
      const sourceSessionIdSet = new Set<string>();
      let nodesTruncated = false;
      let edgesTruncated = false;
      const addNode = (node: GraphNode): boolean => {
        if (nodeIds.has(node.id)) {
          return true;
        }
        if (nodes.length >= nodeLimit) {
          nodesTruncated = true;
          return false;
        }
        nodeIds.add(node.id);
        nodes.push(node);
        return true;
      };
      const addEdge = (edge: GraphEdge): void => {
        if (edgeIds.has(edge.id) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
          return;
        }
        if (edges.length >= edgeLimit) {
          edgesTruncated = true;
          return;
        }
        edgeIds.add(edge.id);
        edges.push(edge);
      };
      const addProjectContext = (project: ProjectRecord): void => {
        if (nodeIds.has(`project:${project.id}`) || nodes.length >= nodeLimit - 1) {
          return;
        }
        addNode({
          id: `project:${project.id}`,
          kind: "project",
          label: project.name,
          projectId: project.id,
          metadata: { rootPath: project.rootPath, status: project.status },
        });
      };
      const addSessionNode = (session: WorkSessionRecord): boolean => {
        const sessionNodeId = `session:${session.id}`;
        if (
          !addNode({
            id: sessionNodeId,
            kind: "session",
            label: session.title,
            projectId: session.projectId,
            sessionId: session.id,
            metadata: {
              completedAt: session.completedAt,
              changedFilesCount: session.changedFiles.length,
              verification: session.verification?.status ?? "not_supplied",
            },
          })
        ) {
          return false;
        }
        const projectNodeId = `project:${session.projectId}`;
        addEdge({
          id: `contains:${session.projectId}:${session.id}`,
          from: projectNodeId,
          to: sessionNodeId,
          kind: "contains",
        });
        if (!sourceSessionIdSet.has(session.id)) {
          sourceSessionIdSet.add(session.id);
          sourceSessionIds.push(session.id);
        }
        return true;
      };
      const addFileRelation = (session: WorkSessionRecord, file: string): boolean => {
        const fileNodeId = `file:${session.projectId}:${file}`;
        if (
          !addNode({
            id: fileNodeId,
            kind: "file",
            label: file,
            projectId: session.projectId,
            metadata: { path: file },
          })
        ) {
          return false;
        }
        addEdge({
          id: `changed-file:${session.id}:${file}`,
          from: `session:${session.id}`,
          to: fileNodeId,
          kind: "changed_file",
        });
        return true;
      };
      const addKnowledgeRelation = (item: KnowledgeRecord, parentId: string): boolean => {
        const knowledgeNodeId = `knowledge:${item.id}`;
        if (
          !addNode({
            id: knowledgeNodeId,
            kind: "knowledge",
            label: item.title,
            projectId: item.projectId,
            sessionId: item.sessionId,
            metadata: { kind: item.kind, status: item.status, tagsCount: item.tags.length },
          })
        ) {
          return false;
        }
        addEdge({
          id: `has-knowledge:${parentId}:${item.id}`,
          from: parentId,
          to: knowledgeNodeId,
          kind: "has_knowledge",
        });
        return true;
      };
      const addEvidenceRelation = (item: GraphEvidenceRow): boolean => {
        const evidenceNodeId = `evidence:${item.id}`;
        if (
          !addNode({
            id: evidenceNodeId,
            kind: "evidence",
            label: `${item.kind}: ${truncateText(item.summary ?? item.reference, 120)}`,
            projectId: item.project_id,
            sessionId: item.session_id,
            metadata: {
              kind: item.kind,
              reference: item.reference,
              capturedAt: item.captured_at,
            },
          })
        ) {
          return false;
        }
        addEdge({
          id: `has-evidence:${item.session_id}:${item.id}`,
          from: `session:${item.session_id}`,
          to: evidenceNodeId,
          kind: "has_evidence",
        });
        return true;
      };

      if (phase === "projects") {
        while (projectOffset < projects.length) {
          const project = projects[projectOffset]!;
          if (
            !addNode({
              id: `project:${project.id}`,
              kind: "project",
              label: project.name,
              projectId: project.id,
              metadata: { rootPath: project.rootPath, status: project.status },
            })
          ) {
            break;
          }
          projectOffset += 1;
        }
        if (projectOffset >= projects.length) {
          phase = "sessions";
        }
      }

      if (phase === "sessions") {
        let pageSessionCount = 0;
        while (sessionOffset < allSessionsForCounts.length && pageSessionCount < sessionLimit) {
          const session = allSessionsForCounts[sessionOffset]!;
          const project = projects.find((candidate) => candidate.id === session.projectId);
          if (project) {
            addProjectContext(project);
          }
          if (!addSessionNode(session)) {
            break;
          }

          const sessionKnowledge = knowledgeBySession.get(session.id) ?? [];
          const sessionEvidence = evidenceBySession.get(session.id) ?? [];
          const relationCount = session.changedFiles.length + sessionKnowledge.length + sessionEvidence.length;
          const relationStart = Math.min(relationOffset, relationCount);
          let relationIndex = relationStart;
          for (; relationIndex < relationCount; relationIndex += 1) {
            const fileCount = session.changedFiles.length;
            const knowledgeCountForSession = sessionKnowledge.length;
            const relationAdded =
              relationIndex < fileCount
                ? addFileRelation(session, session.changedFiles[relationIndex]!)
                : relationIndex < fileCount + knowledgeCountForSession
                  ? addKnowledgeRelation(sessionKnowledge[relationIndex - fileCount]!, `session:${session.id}`)
                  : addEvidenceRelation(sessionEvidence[relationIndex - fileCount - knowledgeCountForSession]!);
            if (!relationAdded) {
              break;
            }
          }
          if (relationIndex < relationCount) {
            relationOffset = relationIndex;
            break;
          }
          relationOffset = 0;
          sessionOffset += 1;
          pageSessionCount += 1;
        }

        if (sessionOffset >= allSessionsForCounts.length && relationOffset === 0) {
          phase = "project_knowledge";
          relationOffset = Math.min(
            decodedCursor?.phase === "project_knowledge" ? decodedCursor.relationOffset : 0,
            projectKnowledge.length,
          );
        }
      }

      if (phase === "project_knowledge") {
        while (relationOffset < projectKnowledge.length) {
          const item = projectKnowledge[relationOffset]!;
          const project = projects.find((candidate) => candidate.id === item.projectId);
          if (project) {
            addProjectContext(project);
          }
          if (!addKnowledgeRelation(item, `project:${item.projectId}`)) {
            break;
          }
          relationOffset += 1;
        }
      }

      const hasNext =
        phase === "projects"
          ? projectOffset < projects.length
          : phase === "sessions"
            ? sessionOffset < allSessionsForCounts.length || relationOffset > 0 || projectKnowledge.length > 0
            : relationOffset < projectKnowledge.length;
      const nextCursor = hasNext
        ? encodeGraphCursor({ phase, projectOffset, sessionOffset, relationOffset }, cursorScope)
        : undefined;
      nodesTruncated = nodesTruncated || hasNext || nodes.length < totalNodes;
      edgesTruncated = edgesTruncated || hasNext || edges.length < totalEdges;
      const pageInfo = {
        unit: "sessions" as const,
        phase,
        offset: pageStartSessionOffset,
        pageSize: sessionLimit,
        hasNext,
      };

      return {
        outcome: "graph",
        project: scopedProject,
        projects,
        nodes,
        edges,
        totalNodes,
        totalEdges,
        totalNodesByKind,
        sourceProjectIds: projects.map((project) => project.id),
        sourceSessionIds,
        truncation: {
          nodeLimit,
          edgeLimit,
          nodesTruncated,
          edgesTruncated,
        },
        pageInfo,
        ...(options.cursor && decodedCursor ? { cursor: options.cursor } : {}),
        ...(nextCursor ? { nextCursor } : {}),
      };
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const sourceSessionIds: string[] = [];
    const sourceSessionIdSet = new Set<string>();
    let nodesTruncated = false;
    let edgesTruncated = false;
    const addNode = (node: GraphNode): void => {
      if (!nodeIds.has(node.id)) {
        if (nodes.length >= nodeLimit) {
          nodesTruncated = true;
          return;
        }
        nodeIds.add(node.id);
        nodes.push(node);
      }
    };
    const addEdge = (edge: GraphEdge): void => {
      if (edgeIds.has(edge.id) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        return;
      }
      if (edges.length >= edgeLimit) {
        edgesTruncated = true;
        return;
      }
      edgeIds.add(edge.id);
      edges.push(edge);
    };

    for (const project of projects) {
      const projectNodeId = `project:${project.id}`;
      addNode({
        id: projectNodeId,
        kind: "project",
        label: project.name,
        projectId: project.id,
        metadata: { rootPath: project.rootPath, status: project.status },
      });
      if (!nodeIds.has(projectNodeId)) {
        continue;
      }

      const sessions = cursorRequested
        ? (sessionsByProject.get(project.id) ?? [])
        : (sessionsByProject.get(project.id) ?? []).slice(0, sessionLimit);
      for (const session of sessions) {
        const sessionNodeId = `session:${session.id}`;
        addNode({
          id: sessionNodeId,
          kind: "session",
          label: session.title,
          projectId: project.id,
          sessionId: session.id,
          metadata: {
            completedAt: session.completedAt,
            changedFilesCount: session.changedFiles.length,
            verification: session.verification?.status ?? "not_supplied",
          },
        });
        if (!nodeIds.has(sessionNodeId)) {
          break;
        }
        addEdge({
          id: `contains:${project.id}:${session.id}`,
          from: projectNodeId,
          to: sessionNodeId,
          kind: "contains",
        });
        if (!sourceSessionIdSet.has(session.id)) {
          sourceSessionIdSet.add(session.id);
          sourceSessionIds.push(session.id);
        }

        for (const file of session.changedFiles) {
          const fileNodeId = `file:${project.id}:${file}`;
          addNode({
            id: fileNodeId,
            kind: "file",
            label: file,
            projectId: project.id,
            metadata: { path: file },
          });
          addEdge({
            id: `changed-file:${session.id}:${file}`,
            from: sessionNodeId,
            to: fileNodeId,
            kind: "changed_file",
          });
          if (nodesTruncated) {
            break;
          }
        }
        if (nodesTruncated) {
          break;
        }
      }

      if (nodesTruncated) {
        break;
      }

      const knowledgeItems = (knowledgeByProject.get(project.id) ?? []).slice(0, Math.min(200, nodeLimit));
      for (const item of knowledgeItems) {
        const knowledgeNodeId = `knowledge:${item.id}`;
        addNode({
          id: knowledgeNodeId,
          kind: "knowledge",
          label: item.title,
          projectId: project.id,
          sessionId: item.sessionId,
          metadata: { kind: item.kind, status: item.status, tagsCount: item.tags.length },
        });
        if (!nodeIds.has(knowledgeNodeId)) {
          break;
        }
        const parentId =
          item.sessionId && nodeIds.has(`session:${item.sessionId}`) ? `session:${item.sessionId}` : projectNodeId;
        addEdge({
          id: `has-knowledge:${parentId}:${item.id}`,
          from: parentId,
          to: knowledgeNodeId,
          kind: "has_knowledge",
        });
      }

      if (nodesTruncated) {
        break;
      }

      const sessionIds = sessions.map((session) => session.id);
      if (sessionIds.length > 0) {
        const selectedEvidenceRows = sessionIds
          .flatMap((sessionId) => evidenceBySession.get(sessionId) ?? [])
          .sort((left, right) => left.captured_at.localeCompare(right.captured_at) || left.id.localeCompare(right.id));
        for (const item of selectedEvidenceRows) {
          const evidenceNodeId = `evidence:${item.id}`;
          addNode({
            id: evidenceNodeId,
            kind: "evidence",
            label: `${item.kind}: ${truncateText(item.summary ?? item.reference, 120)}`,
            projectId: item.project_id,
            sessionId: item.session_id,
            metadata: {
              kind: item.kind,
              reference: item.reference,
              capturedAt: item.captured_at,
            },
          });
          if (!nodeIds.has(evidenceNodeId)) {
            break;
          }
          addEdge({
            id: `has-evidence:${item.session_id}:${item.id}`,
            from: `session:${item.session_id}`,
            to: evidenceNodeId,
            kind: "has_evidence",
          });
        }
      }

      if (nodesTruncated) {
        break;
      }
    }

    nodesTruncated = nodesTruncated || nodes.length < totalNodes;
    edgesTruncated = edgesTruncated || edges.length < totalEdges;

    return {
      outcome: "graph",
      project: scopedProject,
      projects,
      nodes,
      edges,
      totalNodes,
      totalEdges,
      totalNodesByKind,
      sourceProjectIds: projects.map((project) => project.id),
      sourceSessionIds,
      truncation: {
        nodeLimit,
        edgeLimit,
        nodesTruncated,
        edgesTruncated,
      },
    };
  }
}
