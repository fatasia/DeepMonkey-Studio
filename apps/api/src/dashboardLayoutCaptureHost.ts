import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { pipeline } from "node:stream/promises";
import {
  DashboardLayoutFontMissingError,
  type DashboardLayoutCaptureHost,
  type DashboardLayoutCaptureRequest,
  type DashboardMeasuredLayout,
  type DashboardMeasuredLayoutRecord,
} from "./dashboardMeasuredLayout.js";

/**
 * G04 切片 B:API 进程可用的正式 Chromium 布局测量宿主。
 *
 * 复用 scripts/verify-dashboard-trusted-layout-host.mts 已验证的捕获页协议
 * (addInitScript 注入请求、页面自测量、FontFace 注入 + 排版宽度探针),每次捕获
 * 使用新建隔离页面(playwright `browser.newPage()` 每次开新 context)并即用即关。
 *
 * 诚实边界:
 * - 捕获页在字体字节无效或缺失时回退 css-binding 几何测量;该模式测的是回退字体
 *   几何,**不声明与交付字体逐像素等价**(verify 脚本 evidence 中的 test-only 口径)。
 *   本宿主对字体 fail-closed:页面探针报告任何字体未生效即按
 *   `DashboardLayoutFontMissingError` 拒绝。
 * - 已验证捕获页固定以 zh-CN 渲染;其余 locale 的测量会静默错绑几何,直接拒绝。
 * - 本模块只提供宿主能力,接进 `prepareDashboardRuntimeArtifactCompilerInput` 的
 *   `layoutCapture` 注入点;端到端生产链(部署接线与能力上报)由后续切片完成。
 */

/** 结构化最小页面接口:默认实现包装 playwright Page;测试注入 stub。 */
export interface DashboardCapturePage {
  addInitScript(script: (injected: unknown) => void, arg: unknown): Promise<void> | void;
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options?: { readonly timeout?: number }): Promise<unknown>;
  evaluate<T>(script: () => T): Promise<T>;
  close(): Promise<void>;
  on(event: "crash" | "close", listener: () => void): unknown;
}

export interface DashboardCaptureBrowser {
  newPage(options?: { readonly viewport?: { readonly width: number; readonly height: number } }): Promise<DashboardCapturePage>;
  close(): Promise<void>;
}

export interface DashboardChromiumLayoutHostOptions {
  readonly id: string;
  readonly version: string;
  readonly chromePath: string;
  /** 已托管的捕获页地址(index.html 所在 URL);与 capturePageEntry 二选一。 */
  readonly capturePageUrl?: string;
  /** 捕获页 esbuild 入口(apps/web/scripts/fixtures/dashboardTrustedLayoutCapture.tsx);给出时宿主自行打包并由进程内 http 服务托管。 */
  readonly capturePageEntry?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  /** 单次捕获整体超时,超时真实关闭页面;默认 30s。 */
  readonly timeoutMs?: number;
  /** 预置可执行文件指纹;缺省时在首次启动浏览器时计算 chromePath 的 SHA-256。 */
  readonly executableSha256?: string;
  /** 测试注入点:替换默认 playwright-core 启动器。 */
  readonly launchBrowser?: (chromePath: string) => Promise<DashboardCaptureBrowser>;
}

export interface DashboardChromiumLayoutHost extends DashboardLayoutCaptureHost {
  /** 关闭浏览器与进程内捕获页服务;幂等。 */
  close(): Promise<void>;
}

const CAPTURE_PROTOCOL = "dashboard-measured-layout-v1";
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const CAPTURE_SELECTOR_TIMEOUT_MS = 15_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const CAPTURE_READY_SELECTOR = '[data-dashboard-capture="value"], [data-dashboard-capture="table"]';
const CAPTURE_PAGE_LOCALE = "zh-CN";

export function createDashboardChromiumLayoutHost(options: DashboardChromiumLayoutHostOptions): DashboardChromiumLayoutHost {
  if (!options.id.trim() || !options.version.trim()) throw new Error("Dashboard layout capture host requires a non-empty id and version");
  if (Boolean(options.capturePageUrl) === Boolean(options.capturePageEntry)) {
    throw new Error("Provide exactly one of capturePageUrl or capturePageEntry for the dashboard capture page");
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("Dashboard layout capture timeoutMs must be a positive number");
  }
  if (options.capturePageEntry && !existsSync(options.capturePageEntry)) {
    throw new Error(`Dashboard capture page entry does not exist: ${options.capturePageEntry}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  let browserPromise: Promise<DashboardCaptureBrowser> | null = null;
  let capturePageUrlPromise: Promise<string> | null = null;
  let managedServer: Server | null = null;
  let managedDirectory: string | null = null;
  let executableSha256 = options.executableSha256;
  let closed = false;

  const ensureBrowser = (): Promise<DashboardCaptureBrowser> => {
    if (closed) return Promise.reject(new Error("Dashboard layout capture host is closed"));
    browserPromise ??= (async () => {
      const browser = await (options.launchBrowser
        ? options.launchBrowser(options.chromePath)
        : launchChromiumBrowser(options.chromePath));
      if (!executableSha256 && !options.launchBrowser) executableSha256 = await sha256File(options.chromePath);
      return browser;
    })();
    // 启动失败允许下一次捕获重试;调用方仍拿到原拒绝。
    browserPromise.catch(() => { browserPromise = null; });
    return browserPromise;
  };

  const ensureCapturePageUrl = (): Promise<string> => {
    if (options.capturePageUrl) return Promise.resolve(options.capturePageUrl);
    capturePageUrlPromise ??= hostCapturePageBundle(options.capturePageEntry!)
      .then(served => { managedServer = served.server; managedDirectory = served.directory; return served.url; });
    capturePageUrlPromise.catch(() => { capturePageUrlPromise = null; });
    return capturePageUrlPromise;
  };

  const close = async (): Promise<void> => {
    closed = true;
    const browser = browserPromise ? await browserPromise.catch(() => null) : null;
    const server = managedServer, directory = managedDirectory;
    browserPromise = null; capturePageUrlPromise = null; managedServer = null; managedDirectory = null;
    await Promise.allSettled([
      browser ? browser.close() : Promise.resolve(),
      server ? new Promise<void>(resolve => { server.close(() => resolve()); }) : Promise.resolve(),
      directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  };

  const capture = async (request: DashboardLayoutCaptureRequest, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if ((request as { protocol: string }).protocol !== CAPTURE_PROTOCOL) {
      throw new Error("Dashboard layout capture request has an unsupported protocol");
    }
    if (request.locale !== CAPTURE_PAGE_LOCALE) {
      throw new Error(`The verified capture page renders ${CAPTURE_PAGE_LOCALE} only;`
        + ` refusing to measure locale ${request.locale} as ${CAPTURE_PAGE_LOCALE} geometry`);
    }
    // 统一停机通道:外部中止 / 超时 / 页面崩溃都走 fail() → 立即真实关页并竞速拒绝,
    // 不等 Chromium 自然结束;迟到的页面结果由 assertLive 丢弃。
    let activePage: DashboardCapturePage | null = null;
    let failure: { readonly reason: unknown } | null = null;
    const stop = new AbortController();
    const fail = (reason: unknown): void => {
      if (!failure) {
        failure = { reason };
        if (activePage) void activePage.close().catch(() => {});
      }
      stop.abort();
    };
    const timer = setTimeout(() => fail(new Error(`Dashboard layout capture timed out after ${timeoutMs}ms; the capture page was closed`)), timeoutMs);
    const onPageCrash = (): void => fail(new Error("Dashboard layout capture page crashed before the measurement completed"));
    const onOuterAbort = (): void => fail(signal!.reason);
    if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
    const stopReason = (): unknown => failure?.reason ?? signal?.reason ?? new Error("Dashboard layout capture was aborted");
    const assertLive = (): void => { signal?.throwIfAborted(); if (failure) throw failure.reason; };

    const flow = (async (): Promise<{
      readonly protocol: typeof CAPTURE_PROTOCOL;
      readonly layout: DashboardMeasuredLayout;
      readonly table?: DashboardMeasuredLayoutRecord["table"];
    }> => {
      let page: DashboardCapturePage | null = null;
      try {
        const browser = await ensureBrowser();
        page = await browser.newPage({ viewport });
        activePage = page;
        page.on("crash", onPageCrash);
        assertLive();
        // 捕获页协议(已验证):顶层 widget/metric/width/height/fonts;字体经 base64 交页面 FontFace 注入。
        // 合同请求的 data.metric 映射为页面 metric;页面自身不产生任何身份字段。
        const pageRequest = {
          widget: request.widget, metric: request.data.metric,
          width: request.logicalSize[0]!, height: request.logicalSize[1]!,
          fonts: request.fonts.map(font => ({ id: font.id, base64: Buffer.from(font.bytes).toString("base64") })),
        };
        await page.addInitScript(injected => { (globalThis as { __LAYOUT_REQUEST__?: unknown }).__LAYOUT_REQUEST__ = injected; }, pageRequest);
        await page.goto(await ensureCapturePageUrl());
        assertLive();
        await page.waitForSelector(CAPTURE_READY_SELECTOR, { timeout: CAPTURE_SELECTOR_TIMEOUT_MS });
        assertLive();
        const fontErrors = toStringList(await page.evaluate(() => (globalThis as { __FONT_ERRORS__?: string[] }).__FONT_ERRORS__ ?? []));
        if (fontErrors.length) throw new DashboardLayoutFontMissingError(fontErrors);
        const captured = await page.evaluate(() => (globalThis as { captureWidget?: () => unknown }).captureWidget?.());
        assertLive();
        if (!isRecord(captured) || !isRecord(captured.layout)) {
          throw new Error("Dashboard capture page returned no measured layout object");
        }
        const table = captured.table;
        return {
          protocol: CAPTURE_PROTOCOL,
          layout: captured.layout as unknown as DashboardMeasuredLayout,
          ...(isRecord(table) ? { table: table as DashboardMeasuredLayoutRecord["table"] } : {}),
        };
      } catch (error) {
        throw signal?.aborted || failure ? stopReason() : error;
      } finally {
        activePage = null;
        if (page) await page.close().catch(() => {});
      }
    })();

    const stopped = new Promise<never>((_, reject) => {
      stop.signal.addEventListener("abort", () => reject(stopReason()), { once: true });
    });
    try {
      return await Promise.race([flow, stopped]);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
      stop.abort();
    }
  };

  // exactOptionalPropertyTypes 下,惰性解析的指纹(启动前为 undefined)只能经此边界断言;
  // 运行时语义与接口一致:未启动时字段表现为缺省。
  return {
    id: options.id,
    version: options.version,
    get executableSha256() { return executableSha256; },
    capture,
    close,
  } as DashboardChromiumLayoutHost;
}

/** 按已验证 verify 脚本的同构选项打包捕获页,并由进程内 http 服务托管。 */
async function hostCapturePageBundle(entry: string): Promise<{
  readonly url: string; readonly server: Server; readonly directory: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-capture-page-"));
  try {
    const { build } = await import("esbuild");
    await build({
      entryPoints: [entry], bundle: true, format: "esm", platform: "browser",
      outfile: path.join(directory, "capture.js"),
      conditions: ["development"], define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
      loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`Failed to bundle the dashboard capture page entry ${entry}: ${(error as Error).message}`);
  }
  const files = new Map<string, Uint8Array>([
    ["index.html", new TextEncoder().encode('<!doctype html><html><head><link rel="stylesheet" href="/capture.css"></head>'
      + '<body><div id="root"></div><script type="module" src="/capture.js"></script></body></html>')],
    ["capture.js", await readFile(path.join(directory, "capture.js"))],
    ["capture.css", await readFile(path.join(directory, "capture.css")).catch(() => new Uint8Array())],
  ]);
  const server = createServer((request, response) => {
    const name = request.url === "/" ? "index.html" : (request.url ?? "").slice(1);
    const body = files.get(name);
    if (!body) { response.writeHead(404).end(); return; }
    // content-type 必须三分支:index.html 若被当作 text/javascript,Chromium 会把源码渲染成纯文本页。
    const contentType = name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "text/javascript";
    response.setHeader("content-type", contentType);
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw new Error("Dashboard capture page server did not bind a TCP port");
  }
  return { url: `http://127.0.0.1:${address.port}/`, server, directory };
}

/** playwright-core 未被 api 直接依赖:先按常规解析,再回退仓库内 cloud-render-worker 的同一份(与 verify 脚本一致)。 */
function loadPlaywrightModule(): { chromium: { launch(options: {
  executablePath: string; headless: boolean;
}): Promise<unknown> } } {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright-core") as { chromium: { launch(options: { executablePath: string; headless: boolean }): Promise<unknown> } };
  } catch { /* 回退到兄弟 worker 包 */ }
  const anchor = new URL("../../../apps/cloud-render-worker/package.json", import.meta.url);
  if (existsSync(anchor)) {
    try {
      return createRequire(anchor)("playwright-core") as { chromium: { launch(options: { executablePath: string; headless: boolean }): Promise<unknown> } };
    } catch { /* 落到可操作报错 */ }
  }
  throw new Error("playwright-core is required to launch the dashboard capture browser;"
    + " install playwright-core or inject a launchBrowser implementation");
}

async function launchChromiumBrowser(chromePath: string): Promise<DashboardCaptureBrowser> {
  if (!existsSync(chromePath)) {
    throw new Error(`Chromium executable not found at ${chromePath};`
      + " point chromePath (env BIM_STUDIO_CHROME_PATH) at a real Chrome/Chromium binary");
  }
  const chromium = loadPlaywrightModule().chromium;
  let browser: unknown;
  try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
  } catch (error) {
    throw new Error(`Failed to launch Chromium at ${chromePath}: ${(error as Error).message}`);
  }
  const raw = browser as {
    newPage(options?: { viewport?: { width: number; height: number } }): Promise<unknown>;
    close(): Promise<void>;
  };
  return {
    newPage: async newPageOptions => wrapPlaywrightPage(await raw.newPage(newPageOptions) as never),
    close: () => raw.close(),
  };
}

type PlaywrightPageLike = {
  addInitScript(script: (injected: unknown) => void, arg?: unknown): unknown;
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  evaluate<T>(script: () => T): Promise<T>;
  close(): Promise<void>;
  on(event: string, listener: () => void): unknown;
};

function wrapPlaywrightPage(page: PlaywrightPageLike): DashboardCapturePage {
  return {
    addInitScript: (script, arg) => { page.addInitScript(script, arg); },
    goto: url => page.goto(url),
    waitForSelector: (selector, waitForOptions) => page.waitForSelector(selector, waitForOptions),
    evaluate: script => page.evaluate(script),
    close: () => page.close(),
    on: (event, listener) => { page.on(event, listener); },
  };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
