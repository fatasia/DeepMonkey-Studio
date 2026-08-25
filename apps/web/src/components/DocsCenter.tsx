import { createElement, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowLeft, BookOpen, ChevronRight, FileText, Hash, Search } from "lucide-react";
import { resolveDocsDestination, searchDocs, type MarkdownBlock, type MarkdownInline } from "@bim-studio/docs-runtime";
import { DOCS_VERSION, docsCategories, docsDocuments } from "../docs/docsCatalog";
import "./DocsCenter.css";

export interface DocsCenterProps {
  documentId?: string;
  onNavigate: (documentId: string, sectionId?: string) => void;
  onClose: () => void;
}

export function DocsCenter({ documentId, onNavigate, onClose }: DocsCenterProps) {
  const [query, setQuery] = useState("");
  const articleRef = useRef<HTMLElement>(null);
  const activeDocument = docsDocuments.find((document) => document.id === documentId) ?? docsDocuments[0];
  const searchResults = useMemo(() => searchDocs(docsDocuments, query), [query]);

  useEffect(() => {
    const hash = decodeHash(window.location.hash);
    const frame = window.requestAnimationFrame(() => {
      if (hash) document.getElementById(hash)?.scrollIntoView({ block: "start" });
      else articleRef.current?.scrollTo({ top: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeDocument?.id, documentId]);

  if (!activeDocument) return null;

  function navigateTo(targetDocumentId: string, sectionId?: string) {
    onNavigate(targetDocumentId, sectionId);
    if (targetDocumentId === activeDocument?.id && sectionId) {
      window.requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ block: "start", behavior: "smooth" }));
    }
  }

  return (
    <main className="docs-center-page">
      <header className="docs-center-header">
        <div className="docs-center-brand">
          <span><BookOpen size={19} /></span>
          <div><strong>使用文档</strong><small>离线产品指南</small></div>
        </div>
        <label className="docs-search-field">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索功能、操作或错误信息"
            aria-label="搜索使用文档"
          />
          {query.trim() && <kbd>{searchResults.length} 条</kbd>}
        </label>
        <div className="docs-center-actions">
          <span>文档版本 {DOCS_VERSION}</span>
          <button type="button" onClick={onClose}><ArrowLeft size={15} />返回主页</button>
        </div>
      </header>

      <div className="docs-center-layout">
        <nav className="docs-navigation" aria-label="文档目录">
          {query.trim() ? (
            <section className="docs-search-results">
              <header><strong>搜索结果</strong><small>{searchResults.length}</small></header>
              {searchResults.length ? searchResults.map((result) => (
                <button
                  type="button"
                  key={`${result.document.id}:${result.section?.id ?? "document"}`}
                  className={result.document.id === activeDocument.id ? "active" : ""}
                  onClick={() => navigateTo(result.document.id, result.section?.id)}
                >
                  <span><FileText size={14} /><strong>{result.document.title}</strong></span>
                  <small>{result.excerpt}</small>
                </button>
              )) : <div className="docs-search-empty"><Search size={22} /><strong>没有找到结果</strong><span>换一个更短的关键词试试</span></div>}
            </section>
          ) : docsCategories.map((category) => (
            <section key={category.id}>
              <header><strong>{category.title}</strong></header>
              {category.documents.map((document) => (
                <button
                  type="button"
                  key={document.id}
                  className={document.id === activeDocument.id ? "active" : ""}
                  onClick={() => navigateTo(document.id)}
                >
                  <FileText size={14} />
                  <span>{document.title}</span>
                  <ChevronRight size={13} />
                </button>
              ))}
            </section>
          ))}
        </nav>

        <article ref={articleRef} className="docs-article" aria-label={activeDocument.title}>
          <div className="docs-article-inner">
            <div className="docs-breadcrumb"><BookOpen size={13} /><span>{activeDocument.category}</span><ChevronRight size={12} /><strong>{activeDocument.title}</strong></div>
            <div className="docs-markdown">
              {activeDocument.blocks.map((block, index) => renderBlock(block, index, activeDocument.id, navigateTo))}
            </div>
            <footer className="docs-article-footer">
              <span>本文档随客户端离线提供</span>
              <span>版本 {activeDocument.version}</span>
            </footer>
          </div>
        </article>

        <aside className="docs-on-this-page" aria-label="本页目录">
          <strong>本页内容</strong>
          {activeDocument.sections.map((section) => (
            <button
              type="button"
              key={section.id}
              className={section.level > 2 ? "nested" : ""}
              onClick={() => navigateTo(activeDocument.id, section.id)}
            >
              <Hash size={11} />{section.title}
            </button>
          ))}
        </aside>
      </div>
    </main>
  );
}

function renderBlock(
  block: MarkdownBlock,
  index: number,
  documentId: string,
  onNavigate: (documentId: string, sectionId?: string) => void
): ReactNode {
  const key = `${block.type}:${"id" in block ? block.id : index}`;
  if (block.type === "heading") {
    return createElement(
      `h${Math.min(6, Math.max(1, block.level))}`,
      { id: block.id, key, tabIndex: -1 },
      renderInline(block.content, documentId, onNavigate)
    );
  }
  if (block.type === "paragraph") return <p key={key}>{renderInline(block.content, documentId, onNavigate)}</p>;
  if (block.type === "quote") return <blockquote key={key}>{renderInline(block.content, documentId, onNavigate)}</blockquote>;
  if (block.type === "divider") return <hr key={key} />;
  if (block.type === "code") return <pre key={key} data-language={block.language || undefined}><code>{block.value}</code></pre>;
  const List = block.ordered ? "ol" : "ul";
  return <List key={key}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, documentId, onNavigate)}</li>)}</List>;
}

function renderInline(
  content: readonly MarkdownInline[],
  documentId: string,
  onNavigate: (documentId: string, sectionId?: string) => void
): ReactNode[] {
  return content.map((item, index) => {
    if (item.type === "text") return item.value;
    if (item.type === "code") return <code key={index}>{item.value}</code>;
    if (item.external) return <a key={index} href={item.href} target="_blank" rel="noreferrer">{item.label}</a>;
    const target = resolveDocsDestination(documentId, item.href);
    return <a
      key={index}
      href={item.href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onNavigate(target.documentId, target.sectionId);
      }}
    >{item.label}</a>;
  });
}

function decodeHash(hash: string): string | undefined {
  if (!hash.startsWith("#") || hash.length === 1) return undefined;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}
