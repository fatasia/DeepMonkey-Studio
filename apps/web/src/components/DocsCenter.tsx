import { createElement, Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ArrowLeft, BookOpen, ChevronRight, FileText, Hash, Menu, Search } from "lucide-react";
import { resolveDocsDestination, searchDocs, type MarkdownBlock, type MarkdownInline } from "@bim-studio/docs-runtime";
import { DOCS_VERSION, docsCategories, docsDocuments } from "../docs/docsCatalog";
import { DocsCenterCodeBlock } from "./DocsCenterCodeBlock";
import { DocsSdkExamples, type DocsSdkExamplesProps } from "./DocsSdkExamples";
import "./DocsCenter.css";

export interface DocsCenterProps {
  documentId?: string;
  systemName: string;
  onNavigate: (documentId: string, sectionId?: string) => void;
  onClose: () => void;
  sdkExampleContext?: DocsSdkExamplesProps["context"];
  onInsertSdkExample?: DocsSdkExamplesProps["onInsert"];
}

export function DocsCenter({ documentId, systemName, onNavigate, onClose, sdkExampleContext, onInsertSdkExample }: DocsCenterProps) {
  const [query, setQuery] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const activeNavigationRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeDocument = docsDocuments.find((document) => document.id === documentId) ?? docsDocuments[0];
  const searchResults = useMemo(() => searchDocs(docsDocuments, query), [query]);
  const activeDocumentIndex = activeDocument ? docsDocuments.indexOf(activeDocument) : -1;
  const previousDocument = activeDocumentIndex > 0 ? docsDocuments[activeDocumentIndex - 1] : undefined;
  const nextDocument = activeDocumentIndex >= 0 ? docsDocuments[activeDocumentIndex + 1] : undefined;

  useEffect(() => {
    const hash = decodeHash(window.location.hash);
    const frame = window.requestAnimationFrame(() => {
      if (hash) document.getElementById(hash)?.scrollIntoView({ block: "start" });
      else articleRef.current?.scrollTo({ top: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeDocument?.id, documentId]);

  useEffect(() => {
    if (query.trim()) return;
    const frame = window.requestAnimationFrame(() => {
      activeNavigationRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeDocument?.id, query]);

  useEffect(() => {
    function focusSearch(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditing = target?.matches("input, textarea, select, [contenteditable='true']") ?? false;
      const shortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (shortcut || (event.key === "/" && !isEditing)) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
      if (event.key === "Escape") setNavigationOpen(false);
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  if (!activeDocument) return null;

  function navigateTo(targetDocumentId: string, sectionId?: string) {
    setNavigationOpen(false);
    onNavigate(targetDocumentId, sectionId);
    if (targetDocumentId === activeDocument?.id && sectionId) {
      window.requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ block: "start", behavior: "smooth" }));
    }
  }

  function selectSearchResult(targetDocumentId: string, sectionId?: string) {
    setQuery("");
    navigateTo(targetDocumentId, sectionId);
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") return;
    if (query) setQuery("");
    else searchInputRef.current?.blur();
  }

  return (
    <main className="docs-center-page">
      <header className="docs-center-header">
        <div className="docs-center-leading">
          <button className="docs-back-button" type="button" onClick={onClose}>
            <ArrowLeft size={16} />返回
          </button>
          <div className="docs-center-brand">
            <span><BookOpen size={19} /></span>
            <div><strong>{systemName} 文档</strong><small>离线产品指南</small></div>
          </div>
        </div>
        <label className="docs-search-field">
          <Search size={16} />
          <input
            ref={searchInputRef}
            value={query}
          onChange={(event) => { setQuery(event.target.value); if (event.target.value.trim()) setNavigationOpen(true); }}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索功能、操作或错误信息"
            aria-label="搜索使用文档"
            aria-keyshortcuts="Control+K Meta+K /"
          />
          <kbd>{query.trim() ? `${searchResults.length} 条` : "Ctrl K"}</kbd>
        </label>
        <div className="docs-center-actions">
          <button className="docs-navigation-toggle" type="button" aria-label="文档目录" aria-expanded={navigationOpen} aria-controls="docs-navigation" onClick={() => setNavigationOpen(open => !open)}><Menu size={17} /></button>
          <span>文档版本 {DOCS_VERSION}</span>
        </div>
      </header>

      <div className={`docs-center-layout${navigationOpen ? " navigation-open" : ""}`}>
        <nav id="docs-navigation" className="docs-navigation" aria-label="文档目录">
          {query.trim() ? (
            <section className="docs-search-results">
              <header><strong>搜索结果</strong><small aria-live="polite">{searchResults.length}</small></header>
              {searchResults.length ? searchResults.map((result) => (
                <button
                  type="button"
                  key={`${result.document.id}:${result.section?.id ?? "document"}`}
                  className={result.document.id === activeDocument.id ? "active" : ""}
                  onClick={() => selectSearchResult(result.document.id, result.section?.id)}
                >
                  <span><FileText size={14} /><strong>{result.document.title}</strong></span>
                  <small title={result.excerpt}>{result.excerpt}</small>
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
                  aria-current={document.id === activeDocument.id ? "page" : undefined}
                  {...(document.id === activeDocument.id ? { ref: activeNavigationRef } : {})}
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
              {activeDocument.blocks.map((block, index) => <Fragment key={index}>
                {renderBlock(block, index, activeDocument.id, navigateTo)}
                {activeDocument.id === "sdk-examples" && index === 1 && <DocsSdkExamples {...(sdkExampleContext ? { context: sdkExampleContext } : {})} {...(onInsertSdkExample ? { onInsert: onInsertSdkExample } : {})} />}
              </Fragment>)}
            </div>
            <footer className="docs-article-footer">
              <div><span>本文档随客户端离线提供</span><span>版本 {activeDocument.version}</span></div>
              <nav className="docs-article-pagination" aria-label="相邻文档">
                {previousDocument && <button type="button" onClick={() => navigateTo(previousDocument.id)}><ArrowLeft size={12} />{previousDocument.title}</button>}
                {nextDocument && <button type="button" onClick={() => navigateTo(nextDocument.id)}>{nextDocument.title}<ChevronRight size={12} /></button>}
              </nav>
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
  // Markdown 行内图片允许写在普通段落里；渲染时拆成同级 p/figure，避免 figure 嵌套 p 造成非法 HTML。
  if (block.type === "paragraph") return <Fragment key={key}>{renderParagraph(block.content, documentId, onNavigate)}</Fragment>;
  if (block.type === "quote") return <blockquote key={key}>{renderInline(block.content, documentId, onNavigate)}</blockquote>;
  if (block.type === "divider") return <hr key={key} />;
  if (block.type === "code") return <DocsCenterCodeBlock key={key} value={block.value} {...(block.language ? { language: block.language } : {})} />;
  const List = block.ordered ? "ol" : "ul";
  return <List key={key}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, documentId, onNavigate)}</li>)}</List>;
}

function renderInline(
  content: readonly MarkdownInline[],
  documentId: string,
  onNavigate: (documentId: string, sectionId?: string) => void
): ReactNode[] {
  return content.map((item, index) => renderInlineItem(item, index, documentId, onNavigate));
}

function renderParagraph(
  content: readonly MarkdownInline[],
  documentId: string,
  onNavigate: (documentId: string, sectionId?: string) => void
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let paragraphItems: ReactNode[] = [];
  const flushParagraph = () => {
    if (!paragraphItems.length) return;
    nodes.push(<p key={`paragraph-${nodes.length}`}>{paragraphItems}</p>);
    paragraphItems = [];
  };
  content.forEach((item, index) => {
    if (item.type !== "image") {
      paragraphItems.push(renderInlineItem(item, index, documentId, onNavigate));
      return;
    }
    flushParagraph();
    nodes.push(renderInlineItem(item, index, documentId, onNavigate));
  });
  flushParagraph();
  return nodes;
}

function renderInlineItem(
  item: MarkdownInline,
  key: number,
  documentId: string,
  onNavigate: (documentId: string, sectionId?: string) => void
): ReactNode {
  if (item.type === "text") return item.value;
  if (item.type === "code") return <code key={key}>{item.value}</code>;
  if (item.type === "image") {
    const source = /^(https?:|data:|blob:)/i.test(item.href) || item.href.startsWith("/") ? item.href : `/${item.href}`;
    return (
      <figure key={key} className="docs-image">
        <img src={source} alt={item.alt} loading="lazy" />
        <figcaption>{item.alt}</figcaption>
      </figure>
    );
  }
  if (item.external) return <a key={key} href={item.href} target="_blank" rel="noreferrer">{item.label}</a>;
  const target = resolveDocsDestination(documentId, item.href);
  return <a
    key={key}
    href={item.href}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onNavigate(target.documentId, target.sectionId);
    }}
  >{item.label}</a>;
}

function decodeHash(hash: string): string | undefined {
  if (!hash.startsWith("#") || hash.length === 1) return undefined;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}
