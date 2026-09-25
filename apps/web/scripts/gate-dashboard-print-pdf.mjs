import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

// PDFium renders the generated PDF itself; pdfplumber measures its text in paper points.
// Override on hosts without the bundled Python runtime (requires pdfplumber/pypdfium2).
const bundledPython = resolve(process.env.LOCALAPPDATA ?? "", "../../.cache/workspace-runtimes/dependencies/python/python.exe");
const python = process.env.BIM_STUDIO_PDF_PYTHON ?? (existsSync(bundledPython) ? bundledPython : "python");
const decodePdf = String.raw`
import json, sys, pdfplumber, pypdfium2 as pdfium
path = sys.argv[1]
result = []
with pdfplumber.open(path) as doc:
    for page in doc.pages:
        words = page.extract_words()
        result.append(dict(width=page.width, height=page.height, text=page.extract_text(), words=words))
doc = pdfium.PdfDocument(path)
for index in range(len(doc)):
    image = doc[index].render(scale=1.5).to_pil().convert('RGB')
    result[index]['paperCorners'] = [image.getpixel(point) for point in [(5, 5), (image.width-6, 5), (5, image.height-6), (image.width-6, image.height-6)]]
    image.save(path.replace('.pdf', '-page-%d.png' % (index + 1)))
print(json.dumps(result, ensure_ascii=True))
`;

function inspectPdf(path, { sample, title, landscape }) {
  const pages = JSON.parse(execFileSync(python, ["-c", decodePdf, path], { encoding: "utf8", windowsHide: true }));
  writeFileSync(path.replace(".pdf", "-decoded.json"), JSON.stringify(pages, null, 2));
  assert.equal(pages.length, 1, "A4 export must not add a blank second page");
  const page = pages[0], mm = 72 / 25.4;
  assert.ok(Math.abs(page.width - (landscape ? 297 : 210) * mm) < 1);
  assert.ok(Math.abs(page.height - (landscape ? 210 : 297) * mm) < 1);
  const flattened = page.text.replace(/\s/g, "");
  assert.ok(flattened.includes(title), "Saved application name must appear in actual PDF header");
  assert.equal(flattened.includes("包含示例数据，仅供演示"), sample, "Sample notice must match printed page data");
  assert.ok(flattened.includes("1/1"), "Actual PDF must contain page count");
  assert.ok(!flattened.includes("返回编辑") && !flattened.includes("项目控制"), "Editor chrome must not enter PDF");
  assert.ok(!flattened.includes("CSV") && !flattened.includes("Excel"), "Table export controls must not enter PDF");
  assert.ok(page.paperCorners.every(pixel => pixel.every(channel => channel >= 250)), "Paper margins must stay white in both themes");
  const header = page.words.filter(word => word.text.includes(title));
  assert.equal(header.length, 1);
  assert.ok(header[0].top >= 9 * mm && header[0].bottom <= 17 * mm, "Header stays above artboard");
  const content = page.words.filter(word => word.top >= 18 * mm && word.bottom < page.height - 18 * mm);
  assert.ok(content.length >= (sample ? 15 : 2), "PDF must contain printable content, not only header/footer");
  if (sample) {
    const footer = page.words.find(word => word.text.includes("包含示例数据"));
    assert.ok(footer && footer.top >= page.height - 17 * mm && footer.bottom <= page.height - 9 * mm);
    assert.ok(flattened.includes("2,600") || flattened.includes("2600"), "Rendered sample KPI must survive PDF generation");
  }
  for (const word of page.words) assert.ok(word.x0 >= 7 * mm && word.x1 <= page.width - 7 * mm, `Paper text clipping: ${word.text}`);
  return { pages: pages.length, width: page.width, height: page.height, paperCorners: page.paperCorners, text: page.text, words: page.words, rendered: path.replace(".pdf", "-page-1.png") };
}

const gate = await createIsolatedStudioGate("dashboard-print-pdf");
const report = { cases: [], boundary: "Actual Chromium PDF + PDFium rendering; sample and static non-sample pages, not live-source integration." };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [], exports: [] };
    report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    // Record the latest actual Canvas text draw, so PDF chart truncation cannot hide behind DOM assertions.
    await page.addInitScript(() => {
      const originalText = CanvasRenderingContext2D.prototype.fillText;
      const originalClear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        this.canvas.__gateChartText = [];
        return Reflect.apply(originalClear, this, args);
      };
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        if (this.canvas.closest(".dashboard-chart")) {
          this.canvas.__gateChartText ??= [];
          this.canvas.__gateChartText.push(String(text));
        }
        return Reflect.apply(originalText, this, [text, ...args]);
      };
    });
    page.setDefaultTimeout(25000); observeDiagnostics(page, entry);
    try {
      const project = await gate.json("POST", "/api/projects", { name: `PDF gate ${round} ${theme}` });
      const { application, appPath } = await createScene(gate, page, project.id);
      const authored = structuredClone(application), title = `PDF-${round}-${theme}`;
      authored.metadata.name = title; authored.pages[0].nodes = [];
      authored.pages[0].width = theme === "dark" ? 1920 : 1080;
      authored.pages[0].height = theme === "dark" ? 1080 : 1920;
      await gate.json("PUT", appPath, authored);
      const pageUrl = `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`;
      await page.goto(pageUrl);
      await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
      await page.getByRole("button", { name: "模板", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "看板模板库", exact: true });
      await modal.getByRole("textbox", { name: "搜索模板或行业" }).fill("生产运行监控");
      await modal.locator("article").filter({ has: page.locator("strong", { hasText: "生产运行监控 · 经营总览" }) }).getByRole("button", { name: "插入当前页面", exact: true }).click();
      const saving = page.waitForResponse(response => response.url().endsWith(appPath) && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存", exact: true }).click(); assert.ok((await saving).ok());
      const saved = await gate.json("GET", appPath);
      for (const sample of [true, false]) {
        if (!sample) {
          // Preserve authored text only. This checks absence, without relabeling fixture rows as real data.
          const staticPage = structuredClone(saved);
          staticPage.pages[0].nodes = staticPage.pages[0].nodes.filter(node => node.kind === "data-widget" && node.widget.type === "decoration");
          assert.ok(staticPage.pages[0].nodes.length > 0);
          staticPage.pages[0].nodes[0].widget.content = "静态生产概览 / STATIC REPORT";
          await gate.json("PUT", appPath, staticPage);
        }
        await page.goto(pageUrl); await page.locator(".dashboard-artboard .dashboard-node").first().waitFor();
        await page.getByRole("button", { name: "浏览", exact: true }).click();
        const runtime = page.locator(".dashboard-runtime-preview"); await runtime.waitFor();
        const screenTheme = await page.locator("html").getAttribute("data-theme");
        assert.equal(screenTheme, theme, "Verify actual brand theme before paper rendering");
        if (sample) await page.locator(".dashboard-value strong").first().getByText(/2,?600/).waitFor();
        await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(1200);
        assert.equal(await page.locator(".dashboard-print-header").isVisible(), false);
        const before = await runtime.locator(".dashboard-runtime-artboard").boundingBox();
        const prefix = `r${round}-${theme}-${sample ? "sample" : "static"}`;
        await page.screenshot({ path: resolve(gate.output, `${prefix}-screen.png`) });
        const path = resolve(gate.output, `${prefix}.pdf`);
        await page.pdf({ path, preferCSSPageSize: true, printBackground: true });
        const chartText = await page.locator(".dashboard-chart canvas").evaluateAll(canvases => canvases.flatMap(canvas => canvas.__gateChartText ?? []));
        if (sample) {
          assert.ok(chartText.some(text => /%$/.test(text)), "Actual pie percentage labels must be drawn");
          assert.ok(!chartText.some(text => /^\d[\d.,]*(?:\.{3}|…)$/.test(text)), `Truncated chart number: ${chartText.join(" | ")}`);
        }
        entry.exports.push({ sample, chartText, ...inspectPdf(path, { sample, title, landscape: theme === "dark" }) });
        const after = await runtime.locator(".dashboard-runtime-artboard").boundingBox();
        assert.ok(Math.abs(after.width - before.width) < 1);
        assert.ok(await page.getByRole("button", { name: "返回编辑", exact: true }).isVisible());
      }
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-failed.png`) }); throw error; }
    finally { await context.close(); console.log(JSON.stringify({ ...entry, exports: entry.exports.map(({ words, text, ...rest }) => rest) })); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(entry => entry.passed) }));
