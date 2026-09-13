export interface DocsSource {
  id: string;
  category: string;
  order: number;
  version: string;
  markdown: string;
}

export interface DocsSection {
  id: string;
  title: string;
  level: number;
}

export interface DocsDocument extends DocsSource {
  title: string;
  summary: string;
  sections: DocsSection[];
  plainText: string;
  blocks: MarkdownBlock[];
}

export interface DocsCategory {
  id: string;
  title: string;
  documents: DocsDocument[];
}

export interface DocsSearchResult {
  document: DocsDocument;
  score: number;
  section?: DocsSection;
  excerpt: string;
}

export interface DocsLinkIssue {
  sourceId: string;
  destination: string;
  reason: "missing-document" | "missing-section" | "unsafe-scheme";
}

export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "image"; alt: string; href: string }
  | { type: "link"; label: string; href: string; external: boolean };

export type MarkdownBlock =
  | { type: "heading"; level: number; id: string; content: MarkdownInline[] }
  | { type: "paragraph"; content: MarkdownInline[] }
  | { type: "quote"; content: MarkdownInline[] }
  | { type: "list"; ordered: boolean; items: MarkdownInline[][] }
  | { type: "code"; language: string; value: string }
  | { type: "divider" };
