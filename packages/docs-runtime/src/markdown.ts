import type { MarkdownBlock, MarkdownInline } from "./types.js";

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const UNORDERED_ITEM_PATTERN = /^[-*+]\s+(.+)$/;
const ORDERED_ITEM_PATTERN = /^\d+[.)]\s+(.+)$/;

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const slugCounts = new Map<string, number>();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const value: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        value.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, value: value.join("\n") });
      continue;
    }

    const heading = line.match(HEADING_PATTERN);
    if (heading?.[1] && heading[2]) {
      const title = stripInlineMarkup(heading[2]);
      blocks.push({
        type: "heading",
        level: heading[1].length,
        id: uniqueSlug(title, slugCounts),
        content: parseMarkdownInline(heading[2])
      });
      index += 1;
      continue;
    }

    if (/^\s*(---|___|\*\*\*)\s*$/.test(line)) {
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }

    const unordered = line.match(UNORDERED_ITEM_PATTERN);
    const ordered = line.match(ORDERED_ITEM_PATTERN);
    if (unordered?.[1] || ordered?.[1]) {
      const isOrdered = Boolean(ordered?.[1]);
      const items: MarkdownInline[][] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const match = candidate.match(isOrdered ? ORDERED_ITEM_PATTERN : UNORDERED_ITEM_PATTERN);
        if (!match?.[1]) break;
        items.push(parseMarkdownInline(match[1]));
        index += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) {
        quote.push((lines[index] ?? "").slice(2));
        index += 1;
      }
      blocks.push({ type: "quote", content: parseMarkdownInline(quote.join(" ")) });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && isParagraphContinuation(lines[index] ?? "")) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", content: parseMarkdownInline(paragraph.join(" ")) });
  }

  return blocks;
}

export function parseMarkdownInline(value: string): MarkdownInline[] {
  const segments: MarkdownInline[] = [];
  const pattern = /(`[^`]+`)|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) segments.push({ type: "text", value: value.slice(cursor, start) });
    if (match[1]) {
      segments.push({ type: "code", value: match[1].slice(1, -1) });
    } else if (match[3]) {
      segments.push({ type: "image", alt: match[2] || "文档图片", href: match[3] });
    } else if (match[4] && match[5]) {
      segments.push({ type: "link", label: match[4], href: match[5], external: isExternalLink(match[5]) });
    }
    cursor = start + match[0].length;
  }
  if (cursor < value.length) segments.push({ type: "text", value: value.slice(cursor) });
  return segments.length ? segments : [{ type: "text", value }];
}

export function markdownInlineText(content: MarkdownInline[]): string {
  return content.map((item) => {
    if (item.type === "link") return item.label;
    if (item.type === "image") return item.alt;
    return item.value;
  }).join("");
}

export function slugifyHeading(value: string): string {
  const slug = value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function stripInlineMarkup(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();
}

function isParagraphContinuation(line: string): boolean {
  if (!line.trim() || line.startsWith("```") || line.startsWith("> ")) return false;
  if (HEADING_PATTERN.test(line) || UNORDERED_ITEM_PATTERN.test(line) || ORDERED_ITEM_PATTERN.test(line)) return false;
  return !/^\s*(---|___|\*\*\*)\s*$/.test(line);
}

function uniqueSlug(value: string, counts: Map<string, number>): string {
  const base = slugifyHeading(value);
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}
