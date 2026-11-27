type PageTextBlock = { kind: "paragraph"; text: string } | { kind: "list"; ordered: boolean; items: string[] };

const listItemPattern = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*\S)\s*$/;

/** Splits Knowledge page text at line breaks into paragraphs and lists, for rendering as plain text nodes. */
export function pageTextBlocks(content: string): PageTextBlock[] {
  const blocks: PageTextBlock[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = listItemPattern.exec(line);
    if (!match) {
      blocks.push({ kind: "paragraph", text: line.trim() });
      continue;
    }
    const ordered = match[2] !== undefined;
    const last = blocks.at(-1);
    if (last?.kind === "list" && last.ordered === ordered) last.items.push(match[3]!);
    else blocks.push({ kind: "list", ordered, items: [match[3]!] });
  }
  return blocks;
}
