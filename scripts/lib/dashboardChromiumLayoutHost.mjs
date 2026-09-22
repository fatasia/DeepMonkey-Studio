import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDashboardLayoutCaptureCache } from "./dashboardLayoutCaptureCache.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const TIMEOUT_MS = 15_000;

/** Build-time dependency only: the exported native package contains pixels, not this host. */
export async function createDashboardChromiumLayoutHost(configuration, directory) {
  const { chromiumExecutable, playwrightModule } = configuration;
  if (![chromiumExecutable, playwrightModule].every(value => typeof value === "string" && path.isAbsolute(value)))
    throw new Error("Dashboard layout capture requires absolute server-owned Chromium and Playwright paths");
  const executableSha256 = hash(await readFile(chromiumExecutable));
  const script = await readFile(new URL("layout-capture.js", directory));
  const css = await readFile(new URL("layout-capture.css", directory));
  const moduleSha256 = hash(await readFile(playwrightModule));
  const loaded = await import(pathToFileURL(playwrightModule).href);
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  if (!chromium?.launch) throw new Error("Configured module does not provide the Chromium layout driver");
  const identity = { executableSha256, moduleSha256, scriptSha256: hash(script), cssSha256: hash(css) };
  const captureCache = createDashboardLayoutCaptureCache(identity);
  const host = {
    id: "dashboard-chromium-heading", version: "1.0.0", executableSha256, identity,
    async withCaptureSession(callback, signal) {
      signal?.throwIfAborted();
      const session = { pages: new Map() };
      try { return await callback({ ...host, capture: (request, abort) => host.capture(request, abort, session) }); }
      finally { await session.browser?.close().catch(() => {}); }
    },
    async capture(request, signal, session) {
      signal?.throwIfAborted();
      if (hash(await readFile(chromiumExecutable)) !== executableSha256
        || hash(await readFile(playwrightModule)) !== moduleSha256)
        throw new Error("Dashboard layout host changed after deployment");
      if (!request.logicalSize.every(value => Number.isFinite(value) && value > 0 && value <= 4096)
        || !["zh-CN", "en-US"].includes(request.locale)) throw new Error("Unsupported chart capture viewport or locale");
      // FontFace cannot select a TTC face. Refuse rather than measure a different face.
      if (!request.fonts.length || request.fonts.some(font => font.faceIndex !== 0
        || Buffer.from(font.bytes).subarray(0, 4).toString("ascii") === "ttcf"))
        throw new Error("Heading capture requires individual frozen font faces, not collections");
      const cached = captureCache.get(request, signal);
      if (cached) return cached;
      const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(TIMEOUT_MS)]);
      const server = createServer((req, res) => {
        const assets = { "/": ["text/html", '<!doctype html><link rel="stylesheet" href="/capture.css"><div id="root"></div><script type="module" src="/capture.js"></script>'],
          "/capture.js": ["text/javascript", script], "/capture.css": ["text/css", css] };
        const asset = assets[req.url];
        if (!asset) { res.writeHead(404).end(); return; }
        res.setHeader("Content-Type", asset[0]); res.end(asset[1]);
      });
      let browser, page;
      const fontKey = hash(JSON.stringify({ locale: request.locale, fonts: request.fonts.map(font => ({ id: font.id, hash: hash(font.bytes) })) }));
      const abort = () => { void browser?.close().catch(() => {}); };
      deadline.addEventListener("abort", abort, { once: true });
      try {
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        deadline.throwIfAborted();
        const url = `http://127.0.0.1:${server.address().port}`;
        browser = session?.browser ?? await chromium.launch({ executablePath: chromiumExecutable, headless: true, timeout: TIMEOUT_MS });
        if (session) session.browser = browser;
        deadline.throwIfAborted();
        const previous = session?.pages.get(fontKey);
        const viewport = { width: Math.ceil(request.logicalSize[0]), height: Math.ceil(request.logicalSize[1]) };
        const next = { widget: request.widget, metric: request.data.metric, locale: request.locale, table: request.table,
          width: request.logicalSize[0], height: request.logicalSize[1] };
        if (previous) {
          page = previous; await page.setViewportSize(viewport);
          await page.evaluate(value => globalThis.updateDashboardLayout(value), next);
        } else {
        page = await browser.newPage({ viewport,
          locale: request.locale, reducedMotion: "reduce", serviceWorkers: "block" });
        await page.route("**/*", route => {
          const target = new URL(route.request().url());
          return target.origin === url && ["/", "/capture.js", "/capture.css"].includes(target.pathname)
            ? route.continue() : route.abort();
        });
        await page.addInitScript(value => { globalThis.__DASHBOARD_LAYOUT_REQUEST__ = value; }, {
          widget: request.widget, metric: request.data.metric, locale: request.locale,
          table: request.table,
          width: request.logicalSize[0], height: request.logicalSize[1],
          fonts: request.fonts.map(font => ({ id: font.id, base64: Buffer.from(font.bytes).toString("base64") })),
        });
        await page.goto(url, { timeout: TIMEOUT_MS });
        await page.waitForFunction(() => globalThis.__DASHBOARD_LAYOUT_ERROR__ || (
          globalThis.captureDashboardHeading && document.querySelector("[data-dashboard-capture]")), null, { timeout: TIMEOUT_MS });
        if (session) {
          if (session.pages.size >= 4) { const key = session.pages.keys().next().value; await session.pages.get(key).close(); session.pages.delete(key); }
          session.pages.set(fontKey, page);
        }
        }
        const result = await page.evaluate(() => {
          if (globalThis.__DASHBOARD_LAYOUT_ERROR__) throw new Error(globalThis.__DASHBOARD_LAYOUT_ERROR__);
          return globalThis.captureDashboardHeading();
        });
        deadline.throwIfAborted();
        const value = { protocol: "dashboard-measured-layout-v1", ...result };
        captureCache.put(request, value, deadline);
        return value;
      } finally {
        deadline.removeEventListener("abort", abort);
        if (!session) await page?.close().catch(() => {});
        if (!session) await browser?.close().catch(() => {});
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    },
  };
  return host;
}
