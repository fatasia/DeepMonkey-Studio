/** 可信 Chromium 布局宿主端到端验证:真实浏览器测量 → C3 冻结数据/布局 hash 绑定;
 *  覆盖取消、字体缺失、字体 hash 变更与重复捕获。仅本机测试证据,不进入交付物。 */
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";
import { prepareDashboardPublicationFreeze, dashboardCanonicalJsonSha256 } from "../apps/api/src/dashboardPublicationFreeze.ts";
import { captureDashboardMeasuredLayout, verifyDashboardMeasuredLayout, DashboardLayoutFontMissingError } from "../apps/api/src/dashboardMeasuredLayout.ts";
import { dashboardDataRequestId } from "../apps/api/src/dashboardPublishedClosure.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "test-output/dashboard-trusted-layout-host");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!existsSync(chromePath)) { console.log(`SKIPPED: Chromium not found at ${chromePath}; set BIM_STUDIO_CHROME_PATH.`); process.exit(0); }
const fontPath = process.env.DASHBOARD_TRUSTED_LAYOUT_FONT;
const fontfaceMode = Boolean(fontPath);
if (fontPath && !existsSync(fontPath)) throw new Error(`DASHBOARD_TRUSTED_LAYOUT_FONT does not exist: ${fontPath}`);

const require = createRequire(realpathSync(fileURLToPath(new URL("../apps/web/node_modules/vite/package.json", import.meta.url))));
const { build } = require("esbuild");
await mkdir(output, { recursive: true });
const bundle = path.join(output, "capture.js");
await build({
  entryPoints: [fileURLToPath(new URL("../apps/web/scripts/fixtures/dashboardTrustedLayoutCapture.tsx", import.meta.url))],
  bundle: true, format: "esm", platform: "browser", outfile: bundle,
  conditions: ["development"], define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" } });

const fontBytes = fontfaceMode ? new Uint8Array(await readFile(fontPath!)) : new Uint8Array([1, 2, 3]);
const fixtureSource = JSON.parse(await readFile(fileURLToPath(new URL("../packages/deep-engine/fixtures/dashboard-layout-source-v1.json", import.meta.url)), "utf8"));
const widget = { type: "value", title: "有功功率", key: "temperature", unit: "MW", source: "sample", color: "#ffffff" };
const node = { id: "widget-value", kind: "data-widget", zIndex: 3, frame: { x: 20, y: 30, width: 320, height: 120 }, widget };
const metric = { value: 42, samples: [{ time: 1, value: 42 }] };

async function freezeCandidate(fontResourceBytes: Uint8Array) {
  const document = structuredClone(fixtureSource);
  document.application.scripts = [];
  document.application.pages[0]!.nodes = [node];
  return prepareDashboardPublicationFreeze({
    expected: { projectId: "project-golden", applicationId: "application-worker-behavior",
      publicationId: "publication-trusted-layout", applicationRevision: 1 },
    entryPageId: "page-main",
    data: [{ id: dashboardDataRequestId(node.id), nodeId: node.id, sourceRevision: "sample:e2e" }],
    resources: [{ id: "font-main", kind: "font", objectKey: "projects/project-golden/assets/font-main.woff2",
      mime: "font/woff2", nodeIds: [node.id], revision: 3, faceIndex: 0,
      license: { redistributable: true, evidence: fontfaceMode
        ? `local-verification:${path.basename(fontPath!)}; never shipped`
        : "local-verification:synthetic-bytes; never shipped" } }],
    readAuthority: async () => ({ activePublicationId: "publication-trusted-layout", currentApplicationRevision: 1,
      publication: { id: "publication-trusted-layout", projectId: "project-golden", applicationId: "application-worker-behavior",
        applicationRevision: 1, document: document.application, publishedAt: "2026-09-16T12:00:00.000Z" } }),
    resolveData: async () => ({ sourceRevision: "sample:e2e", value: {
      source: { kind: "sample", id: "sample:widget-value", revision: 1, contentSha256: dashboardCanonicalJsonSha256(metric) }, metric } }),
    readResource: async () => ({ revision: 3, bytes: fontResourceBytes }),
  });
}
const candidate = await freezeCandidate(fontBytes);

const server = createServer(async (request, response) => {
  const name = request.url === "/" ? "index.html" : request.url?.slice(1);
  if (name !== "index.html" && name !== "capture.js" && name !== "capture.css") { response.writeHead(404).end(); return; }
  if (name === "index.html") {
    response.setHeader("content-type", "text/html");
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/capture.css"></head><body><div id="root"></div><script type="module" src="/capture.js"></script></body></html>');
    return;
  }
  if (name === "capture.css") {
    response.setHeader("content-type", "text/css");
    response.end(await readFile(path.join(output, "capture.css")));
    return;
  }
  response.setHeader("content-type", "text/javascript");
  response.end(await readFile(bundle));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true });
type LayoutRequest = { widget: unknown; metric: unknown; width: number; height: number; fonts: { id: string; base64?: string }[] };
function createTrustedHost(options: { id: string; injectFonts: boolean; corruptRequestFonts?: boolean } = { id: "chromium-trusted-host", injectFonts: fontfaceMode }) {
  let activePage: playwright.Page | null = null;
  return {
    id: options.id, version: "1.0.0",
    async capture(request: { nodeId: string; logicalSize: readonly [number, number]; widget: unknown; metric: unknown; fonts: { id: string; faceIndex: number; bytes: Uint8Array }[]; locale: string }, signal?: AbortSignal) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      activePage = page;
      const abort = () => { void page.close(); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const fonts = request.fonts.map(font => ({ id: font.id, ...(options.injectFonts
          ? { base64: Buffer.from(options.corruptRequestFonts ? new Uint8Array([0, 1, 2, 3]) : font.bytes).toString("base64") } : {}) }));
        const pageRequest: LayoutRequest = { widget: request.widget, metric: request.metric,
          width: request.logicalSize[0], height: request.logicalSize[1], fonts };
        await page.addInitScript(injected => { (globalThis as { __LAYOUT_REQUEST__?: unknown }).__LAYOUT_REQUEST__ = injected; }, pageRequest);
        await page.goto(url);
        await page.waitForSelector('[data-dashboard-capture="value"], [data-dashboard-capture="table"]', { timeout: 15_000 });
        const fontErrors = await page.evaluate(() => (globalThis as { __FONT_ERRORS__?: string[] }).__FONT_ERRORS__ ?? []);
        if (fontErrors.length) throw new DashboardLayoutFontMissingError(fontErrors);
        const captured = await page.evaluate(() => globalThis.captureWidget()) as { layout: unknown; table?: unknown };
        signal?.throwIfAborted();
        return { protocol: "dashboard-measured-layout-v1" as const,
          layout: captured.layout as never, ...(captured.table ? { table: captured.table as never } : {}) };
      } finally {
        signal?.removeEventListener("abort", abort);
        activePage = null;
        await page.close().catch(() => {});
      }
    },
    get busyPage() { return activePage; },
  };
}
const host = createTrustedHost();
const evidence: Record<string, unknown> = { mode: fontfaceMode ? "fontface-injected" : "css-binding(local-fallback,test-only)", chrome: chromePath };

try {
  // A. 真实测量 → 服务端绑定 → 复核
  const record = await captureDashboardMeasuredLayout({ candidate, nodeId: node.id, host, locale: "zh-CN" });
  verifyDashboardMeasuredLayout(record, candidate);
  assert.equal(record.logicalSize[0], node.frame.width);
  assert.ok(record.layout.textBoxes.some(box => (box.role as { kind: string }).kind === "value"));
  evidence.record = { nodeId: record.nodeId, dataId: record.dataId, layoutSha256: record.layoutSha256,
    binds: record.binds, host: { ...record.host, capturedAt: undefined } };

  // B. 重复捕获:同冻结输入必须得到同布局 hash
  const repeat = await captureDashboardMeasuredLayout({ candidate, nodeId: node.id, host, locale: "zh-CN" });
  assert.equal(repeat.layoutSha256, record.layoutSha256);
  evidence.repeatCapture = { layoutSha256: repeat.layoutSha256, identical: true };

  // C. 取消:预中止 + 在途中止(真实浏览器页被关闭)
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(captureDashboardMeasuredLayout({ candidate, nodeId: node.id, host, locale: "zh-CN", signal: preAborted.signal }));
  const midFlight = new AbortController();
  const pending = captureDashboardMeasuredLayout({ candidate, nodeId: node.id, host, locale: "zh-CN", signal: midFlight.signal });
  setTimeout(() => midFlight.abort(), 60);
  await assert.rejects(pending);
  evidence.cancellation = { preAborted: "rejected-before-host", midFlight: "rejected-and-page-closed" };

  // D. 字体缺失
  if (fontfaceMode) {
    const broken = await freezeCandidate(fontBytes);
    const corruptHost = createTrustedHost({ id: "chromium-trusted-host-corrupt", injectFonts: true, corruptRequestFonts: true });
    await assert.rejects(captureDashboardMeasuredLayout({ candidate: broken, nodeId: node.id, host: corruptHost, locale: "zh-CN" }),
      DashboardLayoutFontMissingError);
    evidence.fontMissing = "invalid-font-bytes-rejected";
  } else {
    const unboundHost = {
      id: "chromium-trusted-host-unbound", version: "1.0.0",
      async capture(request: Parameters<typeof host.capture>[0], signal?: AbortSignal) {
        const captured = await host.capture(request, signal) as { layout: { textBoxes: { fonts: string[] }[] } };
        captured.layout.textBoxes.forEach(box => { box.fonts = ["not-a-frozen-binding"]; });
        return captured as never;
      },
    };
    await assert.rejects(captureDashboardMeasuredLayout({ candidate, nodeId: node.id, host: unboundHost, locale: "zh-CN" }),
      DashboardLayoutFontMissingError);
    evidence.fontMissing = "unbound-font-reference-rejected";
  }

  await writeFile(path.join(output, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(`Trusted Chromium layout host passed (${evidence.mode}): binds verified, repeat-capture hash identical, cancellation and font-missing rejected.`);
  console.log(`Evidence: ${path.join(output, "result.json")}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
