import { parseArchitectureDiagram } from "@work-intelligence/schema";
import { redactText, redactValue } from "./secret-redaction.js";

/** Mask string values before serializing structured data, preserving JSON syntax and references. */
export function redactDiagramSource(source: string, kind: string) {
  if (kind !== "architecture") return redactText(source);
  const diagram = parseArchitectureDiagram(source);
  if (!diagram) throw new Error("Invalid architecture diagram.");
  const masked = redactValue(diagram);
  for (const [index, node] of masked.value.nodes.entries()) {
    node.label = node.label.slice(0, 200);
    if (node.description) node.description = node.description.slice(0, 1_000);
    // A masked path no longer identifies a source file. Omit it rather than exposing a fabricated location.
    if (node.source && redactText(diagram.nodes[index]!.source!.path).redactions.total > 0) delete node.source;
  }
  for (const group of masked.value.groups) {
    group.label = group.label.slice(0, 200);
    if (group.description) group.description = group.description.slice(0, 1_000);
  }
  for (const edge of masked.value.edges) if (edge.label) edge.label = edge.label.slice(0, 200);
  for (const path of masked.value.paths) path.label = path.label.slice(0, 200);
  const value = JSON.stringify(masked.value);
  if (!parseArchitectureDiagram(value)) throw new Error("Invalid masked architecture diagram.");
  return { value, redactions: masked.redactions };
}
