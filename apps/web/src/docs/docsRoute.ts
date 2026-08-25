export interface DocsLocation {
  documentId?: string;
}

export function parseDocsPath(pathname: string): DocsLocation | undefined {
  if (pathname === "/docs" || pathname === "/docs/") return {};
  const match = pathname.match(/^\/docs\/([^/]+)\/?$/);
  if (!match?.[1]) return undefined;
  try {
    const documentId = decodeURIComponent(match[1]);
    return documentId ? { documentId } : undefined;
  } catch {
    return undefined;
  }
}

export function docsPath(documentId?: string, sectionId?: string): string {
  const path = documentId ? `/docs/${encodeURIComponent(documentId)}` : "/docs";
  return sectionId ? `${path}#${encodeURIComponent(sectionId)}` : path;
}
