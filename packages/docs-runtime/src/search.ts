import type { DocsDocument, DocsSearchResult, DocsSection } from "./types.js";

export function searchDocs(documents: readonly DocsDocument[], query: string): DocsSearchResult[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  return documents.flatMap((document) => {
    const title = normalize(document.title);
    const body = normalize(document.plainText);
    if (!terms.every((term) => title.includes(term) || body.includes(term))) return [];

    let score = 0;
    for (const term of terms) {
      if (title === term) score += 30;
      else if (title.includes(term)) score += 14;
      score += countMatches(body, term) * 2;
    }
    const section = bestSection(document.sections, terms);
    if (section) score += 7;
    return [{ document, score, ...(section ? { section } : {}), excerpt: createExcerpt(document.plainText, terms) }];
  }).sort((left, right) => right.score - left.score || left.document.order - right.document.order);
}

function bestSection(sections: readonly DocsSection[], terms: readonly string[]): DocsSection | undefined {
  return sections.find((section) => {
    const title = normalize(section.title);
    return terms.some((term) => title.includes(term));
  });
}

function createExcerpt(value: string, terms: readonly string[]): string {
  const normalized = normalize(value);
  const firstIndex = Math.min(...terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0));
  if (!Number.isFinite(firstIndex)) return value.slice(0, 100);
  const start = Math.max(0, firstIndex - 30);
  const excerpt = value.slice(start, start + 110).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${start + 110 < value.length ? "…" : ""}`;
}

function countMatches(value: string, term: string): number {
  let count = 0;
  let cursor = 0;
  while ((cursor = value.indexOf(term, cursor)) >= 0) {
    count += 1;
    cursor += Math.max(1, term.length);
  }
  return count;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}
