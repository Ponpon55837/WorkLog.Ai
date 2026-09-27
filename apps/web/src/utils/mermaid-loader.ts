/** The only place that imports Mermaid; a dynamic import keeps it out of the main bundle. */
export function importMermaid(): Promise<typeof import("mermaid")> {
  return import("mermaid");
}
