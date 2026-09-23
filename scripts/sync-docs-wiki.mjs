#!/usr/bin/env node
/**
 * Export the offline product documentation to a GitHub Wiki checkout.
 *
 * The application articles are canonical. The Wiki is a generated mirror so
 * users can read the same revision in the repository and in the product.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(repoRoot, "apps", "web", "src", "docs");
const publicDir = join(repoRoot, "apps", "web", "public");
const defaultOutDir = join(repoRoot, "artifacts", "wiki");
const assetsDir = join(publicDir, "docs-assets");

function readArticles() {
  return readdirSync(sourceDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const id = basename(name, ".md");
      const markdown = readFileSync(join(sourceDir, name), "utf8").replace(/\r\n?/g, "\n");
      const title = markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? id;
      return { id, title, markdown, source: join("apps", "web", "src", "docs", name) };
    });
}

/**
 * Group wiki articles by the categories declared in docsCatalog.ts so the
 * catalog stays the single source of truth. Returns entries in catalog order
 * (category first-appearance order, then ascending `order`); articles missing
 * from the catalog fall into a trailing "其他" group.
 */
function readCatalogOrder() {
  const catalogPath = join(sourceDir, "docsCatalog.ts");
  if (!existsSync(catalogPath)) return { groups: [], categories: new Map() };
  const source = readFileSync(catalogPath, "utf8");
  const categories = new Map();
  const entries = [];
  for (const match of source.matchAll(
    /\{\s*id:\s*"([^"]+)"\s*,\s*category:\s*"([^"]+)"\s*,\s*order:\s*([0-9.]+)/g
  )) {
    const [, id, category, order] = match;
    categories.set(id, category);
    entries.push({ id, category, order: Number(order) });
  }
  const seen = [];
  const orders = new Map(entries.map((entry) => [entry.id, entry.order]));
  for (const entry of entries) if (!seen.includes(entry.category)) seen.push(entry.category);
  return { groups: seen, categories, orders };
}

function groupArticles(articles) {
  const { groups, categories, orders } = readCatalogOrder();
  const byCategory = new Map(groups.map((name) => [name, []]));
  const fallback = [];
  for (const article of articles) {
    const category = categories.get(article.id);
    if (category && byCategory.has(category)) byCategory.get(category).push(article);
    else fallback.push(article);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => (orders.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orders.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  const grouped = groups
    .map((name) => ({ name, articles: byCategory.get(name) }))
    .filter((group) => group.articles.length > 0);
  if (fallback.length > 0) grouped.push({ name: "其他", articles: fallback });
  return grouped;
}

function localDocsFromMarkdown(articles) {
  return new Set(articles.map((article) => article.id));
}

function checkArticles(articles) {
  const ids = localDocsFromMarkdown(articles);
  const errors = [];
  for (const article of articles) {
    for (const match of article.markdown.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const destination = match[1];
      if (!destination || /^(?:https?:|mailto:|#)/i.test(destination)) continue;
      const docsMatch = destination.match(/^\/docs\/([^/#)]+)(?:#.*)?$/);
      if (docsMatch) {
        if (!ids.has(docsMatch[1])) errors.push(`${article.id}: missing article ${docsMatch[1]} (${destination})`);
        continue;
      }
      // In-app links also accept bare article ids (resolveDocsDestination in
      // @bim-studio/docs-runtime normalizes them). Flag article-shaped bare
      // destinations that do not match a catalog id so wiki links stay valid.
      const bare = destination.split("#", 1)[0].replace(/^\.\//, "").replace(/\.md$/, "").replace(/\/$/, "");
      if (bare && /^[a-z0-9][a-z0-9-]*$/.test(bare) && !ids.has(bare)) {
        errors.push(`${article.id}: missing article ${bare} (${destination})`);
      }
    }
    for (const match of article.markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      const image = match[1];
      if (/^(?:https?:|data:)/i.test(image)) continue;
      const relative = image.startsWith("/") ? image.slice(1) : image;
      const candidate = join(publicDir, relative);
      if (!existsSync(candidate)) errors.push(`${article.id}: missing image ${image}`);
      if (!relative.startsWith("docs-assets/")) errors.push(`${article.id}: image must use docs-assets/ (${image})`);
    }
  }
  return errors;
}

function rewriteForWiki(markdown, articleIds) {
  const ids = articleIds ?? new Set();
  return markdown
    .replace(/\]\(\/docs\/([^/#)]+)(#[^)]*)?\)/g, (_, id, hash = "") => `](${id}.md${hash})`)
    .replace(/\]\(\/docs-assets\/([^)]*)\)/g, (_, path) => `](docs-assets/${path})`)
    // Bare in-app article links ("See [Deep Engine](deep-engine)") need the
    // .md suffix on GitHub; only rewrite destinations that match a known id.
    .replace(/\]\((?!\/|https?:|mailto:|#|data:)([^)#\s]+)(#[^)]*)?\)/g, (match, path, hash = "") => {
      const normalized = path.replace(/^\.\//, "").replace(/\.md$/, "").replace(/\/$/, "");
      return ids.has(normalized) ? `](${normalized}.md${hash})` : match;
    });
}

function exportWiki(articles, outDir) {
  mkdirSync(outDir, { recursive: true });
  const ids = new Set(articles.map((article) => article.id));
  for (const article of articles) writeFileSync(join(outDir, `${article.id}.md`), rewriteForWiki(article.markdown, ids));
  cpSync(assetsDir, join(outDir, "docs-assets"), { recursive: true, force: true });
  const grouped = groupArticles(articles);
  const linesOf = (group) => group.articles.map((article) => `- [${article.title}](${article.id}.md)`);
  const home = [
    "# Deep Monkey Studio 文档",
    "",
    "本 Wiki 由应用内离线文档生成。正文源位于 `apps/web/src/docs`；请修改正文源后运行 `pnpm docs:wiki:export`，不要直接编辑 Wiki 镜像。",
    "",
    ...grouped.flatMap((group) => [`## ${group.name}`, "", ...linesOf(group), ""])
  ].join("\n");
  writeFileSync(join(outDir, "Home.md"), home);
  const sidebar = [
    "**[文档首页](Home)**",
    "",
    ...grouped.flatMap((group) => [`**${group.name}**`, ...linesOf(group), ""])
  ].join("\n");
  writeFileSync(join(outDir, "_Sidebar.md"), sidebar);
  const manifest = {
    schema: "deep-monkey-docs-wiki.v1",
    source: "apps/web/src/docs",
    articles: articles.map((article) => ({
      id: article.id,
      title: article.title,
      source: article.source,
      sha256: createHash("sha256").update(article.markdown).digest("hex")
    }))
  };
  writeFileSync(join(outDir, ".sync-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function parseArgs(argv) {
  const check = argv.includes("--check");
  const exportIndex = argv.indexOf("--export");
  const outIndex = argv.indexOf("--out-dir");
  const outDir = outIndex >= 0 && argv[outIndex + 1] ? resolve(argv[outIndex + 1]) : defaultOutDir;
  return { check, export: exportIndex >= 0, outDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const articles = readArticles();
  const errors = checkArticles(articles);
  if (errors.length) {
    console.error(errors.map((error) => `✗ ${error}`).join("\n"));
    process.exitCode = 1;
  } else if (options.export) {
    exportWiki(articles, options.outDir);
    console.log(`Exported ${articles.length} articles plus Home/_Sidebar to ${options.outDir}`);
  } else if (options.check) {
    console.log(`Documentation source is consistent (${articles.length} articles)`);
  } else {
    console.log("Usage: node scripts/sync-docs-wiki.mjs --check | --export [--out-dir <directory>]");
  }
}

export { checkArticles, exportWiki, groupArticles, readArticles, rewriteForWiki };
