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
  WorkSessionRecord
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

/** Deterministic graph query and bounded node/edge materialization. */
export class GraphBuilder {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: GraphBuilderDependencies
  ) {}

  public build(options: GraphQuery = {}): GraphQueryResult {
    let scopedProject: ProjectRecord | undefined;
    let projectId = options.projectId;

    if (options.projectRoot) {
      const decision = this.dependencies.checkProjectRoot(options.projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled."
        };
      }
      if (projectId && projectId !== decision.project.id) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: "Project scope does not match projectRoot."
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
            edgesTruncated: false
          }
        };
      }
      const decision = this.dependencies.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled."
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
      ? (this.db
          .prepare(
            `SELECT s.*, p.name AS project_name
             FROM sessions s
             JOIN projects p ON p.id = s.project_id
             WHERE p.status = 'tracked'
               ${projectScopeClause}
             ORDER BY s.completed_at DESC, s.id DESC`
          )
          .all(...projectScopeParameters) as SessionRow[]).map(this.dependencies.toSession)
      : [];
    const knowledgeRows = projects.length
      ? (this.db
          .prepare(
            `SELECT k.*, p.name AS project_name
             FROM knowledge k
             JOIN projects p ON p.id = k.project_id
             WHERE p.status = 'tracked'
               AND k.status = 'active'
               ${projectScopeClause}
             ORDER BY k.updated_at DESC, k.id DESC`
          )
          .all(...projectScopeParameters) as GraphKnowledgeRow[]).map(this.dependencies.toKnowledge)
      : [];
    const evidenceRows = projects.length
      ? (this.db
          .prepare(
            `SELECT e.*, s.title AS session_title, p.name AS project_name
             FROM evidence e
             JOIN sessions s ON s.id = e.session_id
             JOIN projects p ON p.id = s.project_id
             WHERE p.status = 'tracked'
               ${projectScopeClause}
             ORDER BY e.captured_at ASC, e.id ASC`
          )
          .all(...projectScopeParameters) as GraphEvidenceRow[])
      : [];

    const sessionsByProject = new Map<string, WorkSessionRecord[]>();
    for (const session of allSessionsForCounts) {
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
      allSessionsForCounts.flatMap((session) => session.changedFiles.map((file) => `file:${session.projectId}:${file}`))
    );
    const knowledgeCount = knowledgeRows.length;
    const evidenceCount = evidenceRows.length;
    const totalNodes = projects.length + allSessionsForCounts.length + fileNodeIds.size + knowledgeCount + evidenceCount;
    const totalNodesByKind: GraphNodeTotals = {
      project: projects.length,
      session: allSessionsForCounts.length,
      knowledge: knowledgeCount,
      evidence: evidenceCount,
      file: fileNodeIds.size
    };
    const totalEdges = allSessionsForCounts.length
      + allSessionsForCounts.reduce((total, session) => total + session.changedFiles.length, 0)
      + knowledgeCount
      + evidenceCount;
    const sessionLimit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const nodeLimit = Math.min(Math.max(options.maxNodes ?? 180, 1), 500);
    const edgeLimit = Math.min(Math.max(options.maxEdges ?? 360, 1), 1_000);
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
        metadata: { rootPath: project.rootPath, status: project.status }
      });
      if (!nodeIds.has(projectNodeId)) {
        continue;
      }

      const sessions = (sessionsByProject.get(project.id) ?? []).slice(0, sessionLimit);
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
            verification: session.verification?.status ?? "not_supplied"
          }
        });
        if (!nodeIds.has(sessionNodeId)) {
          break;
        }
        addEdge({ id: `contains:${project.id}:${session.id}`, from: projectNodeId, to: sessionNodeId, kind: "contains" });
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
            metadata: { path: file }
          });
          addEdge({ id: `changed-file:${session.id}:${file}`, from: sessionNodeId, to: fileNodeId, kind: "changed_file" });
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
          metadata: { kind: item.kind, status: item.status, tagsCount: item.tags.length }
        });
        if (!nodeIds.has(knowledgeNodeId)) {
          break;
        }
        const parentId = item.sessionId && nodeIds.has(`session:${item.sessionId}`)
          ? `session:${item.sessionId}`
          : projectNodeId;
        addEdge({ id: `has-knowledge:${parentId}:${item.id}`, from: parentId, to: knowledgeNodeId, kind: "has_knowledge" });
      }

      if (nodesTruncated) {
        break;
      }

      const sessionIds = sessions.map((session) => session.id);
      if (sessionIds.length > 0) {
        const selectedEvidenceRows = sessionIds.flatMap((sessionId) => evidenceBySession.get(sessionId) ?? [])
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
              capturedAt: item.captured_at
            }
          });
          if (!nodeIds.has(evidenceNodeId)) {
            break;
          }
          addEdge({
            id: `has-evidence:${item.session_id}:${item.id}`,
            from: `session:${item.session_id}`,
            to: evidenceNodeId,
            kind: "has_evidence"
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
        edgesTruncated
      }
    };
  }
}
