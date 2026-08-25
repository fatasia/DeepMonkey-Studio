import type { DocsDocument, DocsLinkIssue } from "./types.js";

const LINK_PATTERN = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SAFE_EXTERNAL_PATTERN = /^(https?:|mailto:)/i;
const UNSAFE_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;

export function validateDocsLinks(documents: readonly DocsDocument[]): DocsLinkIssue[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const issues: DocsLinkIssue[] = [];

  for (const source of documents) {
    for (const match of source.markdown.matchAll(LINK_PATTERN)) {
      const destination = match[1];
      if (!destination || SAFE_EXTERNAL_PATTERN.test(destination)) continue;
      if (UNSAFE_SCHEME_PATTERN.test(destination)) {
        issues.push({ sourceId: source.id, destination, reason: "unsafe-scheme" });
        continue;
      }

      const target = resolveDocsDestination(source.id, destination);
      const targetDocument = byId.get(target.documentId);
      if (!targetDocument) {
        issues.push({ sourceId: source.id, destination, reason: "missing-document" });
      } else if (target.sectionId && !targetDocument.sections.some((section) => section.id === target.sectionId)) {
        issues.push({ sourceId: source.id, destination, reason: "missing-section" });
      }
    }
  }
  return issues;
}

export function resolveDocsDestination(currentDocumentId: string, destination: string): { documentId: string; sectionId?: string } {
  const [path = "", hash] = destination.split("#", 2);
  let documentId = currentDocumentId;
  if (path) {
    const normalized = path
      .replace(/^\.\//, "")
      .replace(/^\/docs\//, "")
      .replace(/\.md$/, "")
      .replace(/\/$/, "");
    if (normalized) documentId = decodeSafely(normalized.split("/").at(-1) ?? normalized);
  }
  return { documentId, ...(hash ? { sectionId: decodeSafely(hash) } : {}) };
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
