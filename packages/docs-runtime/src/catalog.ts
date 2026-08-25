import { markdownInlineText, parseMarkdown } from "./markdown.js";
import type { DocsCategory, DocsDocument, DocsSection, DocsSource } from "./types.js";

export function createDocsCatalog(sources: readonly DocsSource[]): DocsDocument[] {
  const seenIds = new Set<string>();
  return sources.map((source) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.id)) throw new Error(`文档 ID 不合法：${source.id}`);
    if (seenIds.has(source.id)) throw new Error(`文档 ID 重复：${source.id}`);
    seenIds.add(source.id);

    const blocks = parseMarkdown(source.markdown);
    const headings = blocks.filter((block) => block.type === "heading");
    const titleHeading = headings.find((heading) => heading.level === 1);
    if (!titleHeading) throw new Error(`文档缺少一级标题：${source.id}`);
    const sections: DocsSection[] = headings
      .filter((heading) => heading.level > 1)
      .map((heading) => ({ id: heading.id, title: markdownInlineText(heading.content), level: heading.level }));
    const paragraph = blocks.find((block) => block.type === "paragraph");
    const plainText = blocks.flatMap((block) => {
      if (block.type === "heading" || block.type === "paragraph" || block.type === "quote") return [markdownInlineText(block.content)];
      if (block.type === "list") return block.items.map(markdownInlineText);
      if (block.type === "code") return [block.value];
      return [];
    }).join("\n");

    return {
      ...source,
      title: markdownInlineText(titleHeading.content),
      summary: paragraph ? markdownInlineText(paragraph.content) : "",
      sections,
      plainText,
      blocks
    };
  }).sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, "zh-CN"));
}

export function groupDocsByCategory(documents: readonly DocsDocument[]): DocsCategory[] {
  const categories = new Map<string, DocsDocument[]>();
  for (const document of documents) {
    const group = categories.get(document.category) ?? [];
    group.push(document);
    categories.set(document.category, group);
  }
  return [...categories.entries()].map(([title, items]) => ({
    id: categoryId(title),
    title,
    documents: [...items].sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, "zh-CN"))
  }));
}

function categoryId(value: string): string {
  return `category-${value.normalize("NFKC").replace(/\s+/g, "-").toLocaleLowerCase("zh-CN")}`;
}
