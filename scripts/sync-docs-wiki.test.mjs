import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkArticles, exportWiki, groupArticles, readArticles, rewriteForWiki } from "./sync-docs-wiki.mjs";

test("Wiki export preserves catalog source links and bundles the referenced diagrams", () => {
  const articles = readArticles();
  assert.deepEqual(checkArticles(articles), []);
  assert.ok(articles.some(article => article.id === "sdk-api-overview"));
  assert.match(rewriteForWiki("[API](/docs/api-reference#errors) ![map](/docs-assets/api-call-flow.svg)"), /\]\(api-reference\.md#errors\).*\]\(docs-assets\/api-call-flow\.svg\)/);
  const ids = new Set(articles.map(article => article.id));
  assert.equal(rewriteForWiki("参见 [Deep Engine](deep-engine) 与 [样例](sdk-examples#setup)。", ids), "参见 [Deep Engine](deep-engine.md) 与 [样例](sdk-examples.md#setup)。");
  assert.equal(rewriteForWiki("[未知](not-an-article) 保持原样", ids), "[未知](not-an-article) 保持原样");
  assert.equal(rewriteForWiki("[外链](https://example.com) 不变", ids), "[外链](https://example.com) 不变");
  assert.ok(checkArticles([{ id: "fixture", markdown: "[丢字](deep-engien)" }]).length > 0);

  const outDir = mkdtempSync(join(tmpdir(), "bim-wiki-"));
  try {
    exportWiki(articles, outDir);
    const overview = readFileSync(join(outDir, "sdk-api-overview.md"), "utf8");
    assert.match(overview, /\]\(docs-assets\/api-call-flow\.svg\)/);
    assert.ok(statSync(join(outDir, "docs-assets", "api-call-flow.svg")).size > 0);
    const manifest = JSON.parse(readFileSync(join(outDir, ".sync-manifest.json"), "utf8"));
    assert.equal(manifest.articles.length, articles.length);
    assert.ok(manifest.articles.every(article => /^[a-f0-9]{64}$/.test(article.sha256)));
    const home = readFileSync(join(outDir, "Home.md"), "utf8");
    for (const article of articles) {
      assert.match(home, new RegExp(`\\[${article.title}\\]\\(${article.id}\\.md\\)`));
    }
    const sidebar = readFileSync(join(outDir, "_Sidebar.md"), "utf8");
    assert.match(sidebar, /\[文档首页\]\(Home\)/);
    assert.match(sidebar, /\*\*快速开始\*\*/);
    assert.match(sidebar, /\(getting-started\.md\)/);
    const grouped = groupArticles(articles);
    const groupedIds = grouped.flatMap(group => group.articles.map(article => article.id)).sort();
    assert.deepEqual(groupedIds, articles.map(article => article.id).sort());
    assert.ok(grouped.some(group => group.name === "快速开始" && group.articles.some(article => article.id === "getting-started")));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Wiki source validation rejects missing local screenshots", () => {
  const errors = checkArticles([{ id: "fixture", markdown: "![missing](docs-assets/no-such-image.png)" }]);
  assert.deepEqual(errors, ["fixture: missing image docs-assets/no-such-image.png"]);
});
