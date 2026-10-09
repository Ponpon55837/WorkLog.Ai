import { z } from "zod";

const id = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/)
  .refine((value) => !value.startsWith("sk-") && !/^xox[abprs]-/.test(value), "Ids must not use credential prefixes.");
const label = z.string().trim().min(1).max(200);
const description = z.string().max(1_000).optional();
const sourcePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.includes("\0") &&
      !value.split("/").some((segment) => segment === ".." || segment === "." || segment === ""),
    "Use a project-relative path without traversal or a URL.",
  );

/** Versioned, bounded data only: no HTML, scripts, arbitrary attributes, or file access. */
export const architectureDiagramSchema = z
  .object({
    version: z.literal(1),
    nodes: z
      .array(
        z
          .object({
            id,
            label,
            description,
            groupId: id.optional(),
            position: z
              .object({ x: z.number().finite().min(0).max(10_000), y: z.number().finite().min(0).max(10_000) })
              .strict()
              .optional(),
            source: z
              .object({ path: sourcePath, line: z.number().int().min(1).max(1_000_000).optional() })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    edges: z
      .array(z.object({ id, from: id, to: id, label: label.optional() }).strict())
      .max(500)
      .default([]),
    groups: z.array(z.object({ id, label, description }).strict()).max(40).default([]),
    paths: z
      .array(z.object({ id, label, edgeIds: z.array(id).min(1).max(500) }).strict())
      .max(20)
      .default([]),
  })
  .strict()
  .superRefine((diagram, context) => {
    const fail = (path: (string | number)[], message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    for (const key of ["nodes", "edges", "groups", "paths"] as const) {
      const ids = new Set<string>();
      diagram[key].forEach((item, index) => {
        if (ids.has(item.id)) fail([key, index, "id"], "Ids must be unique within each collection.");
        ids.add(item.id);
      });
    }
    const nodes = new Set(diagram.nodes.map((node) => node.id));
    const groups = new Set(diagram.groups.map((group) => group.id));
    const edges = new Map(diagram.edges.map((edge) => [edge.id, edge]));
    diagram.nodes.forEach((node, index) => {
      if (node.groupId && !groups.has(node.groupId)) fail(["nodes", index, "groupId"], "Unknown group.");
    });
    diagram.edges.forEach((edge, index) => {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) fail(["edges", index], "Unknown endpoint.");
    });
    diagram.paths.forEach((path, index) => {
      path.edgeIds.forEach((edgeId, step) => {
        const edge = edges.get(edgeId);
        const previous = edges.get(path.edgeIds[step - 1] ?? "");
        if (!edge || (step > 0 && previous?.to !== edge.from))
          fail(["paths", index, "edgeIds", step], "Path edges must exist and connect in order.");
      });
    });
  });

export type ArchitectureDiagram = z.infer<typeof architectureDiagramSchema>;

/** Parse source without returning raw input in validation errors. */
export function parseArchitectureDiagram(source: string): ArchitectureDiagram | undefined {
  if (source.length > 100_000) return undefined;
  try {
    const result = architectureDiagramSchema.safeParse(JSON.parse(source));
    return result.success && JSON.stringify(result.data).length <= 100_000 ? result.data : undefined;
  } catch {
    return undefined;
  }
}
