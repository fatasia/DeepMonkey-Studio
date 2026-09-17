import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type DashboardDocument } from "@bim-studio/contracts";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { dashboardCanonicalJsonSha256, prepareDashboardPublicationFreeze,
  type DashboardPublicationFreezeCandidate } from "./dashboardPublicationFreeze.js";
import { dashboardDataRequestId } from "./dashboardPublishedClosure.js";
import { DashboardLayoutFontMissingError, captureDashboardMeasuredLayout, verifyDashboardMeasuredLayout,
  type DashboardLayoutCaptureRequest } from "./dashboardMeasuredLayout.js";
import { createDashboardChromiumLayoutHost, type DashboardCaptureBrowser, type DashboardCapturePage,
  type DashboardChromiumLayoutHost, type DashboardChromiumLayoutHostOptions } from "./dashboardLayoutCaptureHost.js";

/** 确定性测量值:只用于宿主层的回传/剥离断言,形状合法性由合同层测试负责。 */
const measuredLayout: unknown = {
  textBoxes: [{ role: { kind: "value" }, rect: [12, 40, 96, 32], clip: null, fonts: ["font-main"],
    wrap: "none", whiteSpace: "nowrap", verticalAlign: "center",
    style: { fontSize: 32, lineHeight: 40, fontWeight: 600, fontStyle: "normal", align: "left", color: [231, 236, 244, 255] } }],
  backgrounds: [{ rect: [0, 0, 320, 120], color: [0, 0, 0, 0.8] }],
};

class StubPage implements DashboardCapturePage {
  initArgs: unknown[] = [];
  gotos: string[] = [];
  closeCalls = 0;
  captureCalls = 0;
  fontErrors: string[] = [];
  hangCapture = false;
  capturePayload: unknown = { layout: measuredLayout, nodeId: "page-must-not-produce-identity" };
  crashListeners: Array<() => void> = [];
  closeListeners: Array<() => void> = [];
  private captureWaiters: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];

  addInitScript(_script: (injected: unknown) => void, arg: unknown): void { this.initArgs.push(arg); }
  async goto(url: string): Promise<unknown> { this.gotos.push(url); return {}; }
  async waitForSelector(): Promise<unknown> { return {}; }
  evaluate<T>(_script: () => T): Promise<T> {
    // 宿主调用顺序固定:第一次读 __FONT_ERRORS__,第二次执行 captureWidget。
    if (this.captureCalls++ === 0) return Promise.resolve([...this.fontErrors] as T);
    if (this.hangCapture) {
      return new Promise<T>((resolve, reject) => this.captureWaiters.push({ resolve: resolve as (value: unknown) => void, reject }));
    }
    return Promise.resolve(structuredClone(this.capturePayload) as T);
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    for (const waiter of this.captureWaiters.splice(0)) waiter.reject(new Error("Target page closed"));
  }
  on(event: "crash" | "close", listener: () => void): void {
    (event === "crash" ? this.crashListeners : this.closeListeners).push(listener);
  }
  crash(): void { for (const listener of this.crashListeners.splice(0)) listener(); }
}

class StubBrowser implements DashboardCaptureBrowser {
  pages: StubPage[] = [];
  closed = false;
  constructor(private readonly factory: () => StubPage = () => new StubPage()) {}
  async newPage(): Promise<DashboardCapturePage> { const page = this.factory(); this.pages.push(page); return page; }
  async close(): Promise<void> { this.closed = true; }
}

function captureRequest(): DashboardLayoutCaptureRequest {
  return {
    protocol: "dashboard-measured-layout-v1", nodeId: "widget-value", logicalSize: [320, 120],
    widget: { type: "value", title: "有功功率", key: "temperature", unit: "MW" },
    data: { source: { kind: "sample", id: "sample:widget-value" }, metric: { value: 42, samples: [{ time: 1, value: 42 }] } },
    fonts: [{ id: "font-main", faceIndex: 0, bytes: new Uint8Array([1, 2, 3]) }],
    locale: "zh-CN",
  };
}

function stubHost(browser: StubBrowser, overrides: Partial<DashboardChromiumLayoutHostOptions> = {}):
  { host: DashboardChromiumLayoutHost; launches: () => number } {
  let launches = 0;
  const host = createDashboardChromiumLayoutHost({
    id: "chromium-layout-host", version: "0.0.0-stub",
    chromePath: "stub:///chrome", // 仅经 launchBrowser 注入,默认启动器不会被触达
    capturePageUrl: "http://127.0.0.1:9/capture.html",
    launchBrowser: async () => { launches += 1; return browser; },
    ...overrides,
  });
  return { host, launches: () => launches };
}

describe("dashboard chromium layout host", () => {
  it("injects the frozen request, returns only protocol/layout/table and closes the isolated page", async () => {
    const browser = new StubBrowser(); const { host, launches } = stubHost(browser);
    const request = captureRequest();
    const result = await host.capture(request);
    expect(Object.keys(result).sort()).toEqual(["layout", "protocol"]);
    expect(result.protocol).toBe("dashboard-measured-layout-v1");
    expect(result.layout).toEqual(measuredLayout);
    // 页面协议(已验证):widget/metric 来自冻结请求,metric 由合同形状 data.metric 映射,字体转 base64。
    expect(browser.pages[0]!.initArgs[0]).toEqual({
      widget: request.widget, metric: request.data.metric, width: 320, height: 120,
      fonts: [{ id: "font-main", base64: Buffer.from([1, 2, 3]).toString("base64") }],
    });
    expect(browser.pages[0]!.closeCalls).toBe(1);
    // 复用浏览器实例,每次捕获新建隔离页面。
    await host.capture(request);
    expect(launches()).toBe(1);
    expect(browser.pages).toHaveLength(2);
    await host.close();
    await host.close(); // 幂等
    expect(browser.closed).toBe(true);
  });

  it("strips every page-produced field except layout and table", async () => {
    const table = { page: 0, scrollLeft: 0 };
    const page = new StubPage();
    page.capturePayload = { protocol: "forged", layout: measuredLayout, table, nodeId: "forged",
      dataId: "forged", locale: "forged", layoutSha256: "forged", binds: {}, host: {} };
    const { host } = stubHost(new StubBrowser(() => page));
    const result = await host.capture(captureRequest());
    expect(Object.keys(result).sort()).toEqual(["layout", "protocol", "table"]);
    expect(result.table).toEqual(table);
    expect(result).not.toHaveProperty("nodeId");
  });

  it("rejects pre-aborted signals before creating any page", async () => {
    const browser = new StubBrowser(); const { host, launches } = stubHost(browser);
    const controller = new AbortController(); controller.abort();
    await expect(host.capture(captureRequest(), controller.signal)).rejects.toBe(controller.signal.reason);
    expect(browser.pages).toHaveLength(0);
    expect(launches()).toBe(0);
  });

  it("aborts mid-flight by really closing the in-flight page", async () => {
    const page = new StubPage(); page.hangCapture = true;
    const { host } = stubHost(new StubBrowser(() => page));
    const controller = new AbortController();
    const pending = host.capture(captureRequest(), controller.signal);
    await vi.waitFor(() => expect(page.captureCalls).toBe(2));
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(page.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("fails the capture on timeout and closes the page", async () => {
    const page = new StubPage(); page.hangCapture = true;
    const { host } = stubHost(new StubBrowser(() => page), { timeoutMs: 25 });
    await expect(host.capture(captureRequest())).rejects.toThrow(/timed out after 25ms/);
    expect(page.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("fails the capture when the page crashes and closes the page", async () => {
    const page = new StubPage(); page.hangCapture = true;
    const { host } = stubHost(new StubBrowser(() => page), { timeoutMs: 5_000 });
    const pending = host.capture(captureRequest());
    await vi.waitFor(() => expect(page.crashListeners.length).toBeGreaterThan(0));
    page.crash();
    await expect(pending).rejects.toThrow(/page crashed/);
    expect(page.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("rejects fonts whose bytes did not take effect with DashboardLayoutFontMissingError", async () => {
    const page = new StubPage(); page.fontErrors = ["font-main"];
    const { host } = stubHost(new StubBrowser(() => page));
    const pending = host.capture(captureRequest());
    await expect(pending).rejects.toBeInstanceOf(DashboardLayoutFontMissingError);
    await pending.catch((error: DashboardLayoutFontMissingError) => expect(error.families).toEqual(["font-main"]));
    expect(page.captureCalls).toBe(1); // 字体未生效即拒绝,不走 captureWidget
    expect(page.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("refuses unsupported protocols and locales before launching anything", async () => {
    const browser = new StubBrowser(); const { host } = stubHost(browser);
    await expect(host.capture({ ...captureRequest(), protocol: "other" as never })).rejects.toThrow(/unsupported protocol/);
    await expect(host.capture({ ...captureRequest(), locale: "en-US" })).rejects.toThrow(/zh-CN/);
    expect(browser.pages).toHaveLength(0);
  });

  it("validates host options at creation", () => {
    const base = { id: "host", version: "1", chromePath: "chrome" };
    expect(() => createDashboardChromiumLayoutHost(base)).toThrow(/capturePageUrl or capturePageEntry/);
    expect(() => createDashboardChromiumLayoutHost({ ...base, capturePageUrl: "http://x", capturePageEntry: "entry" }))
      .toThrow(/capturePageUrl or capturePageEntry/);
    expect(() => createDashboardChromiumLayoutHost({ ...base, id: " ", capturePageUrl: "http://x" })).toThrow(/id and version/);
    expect(() => createDashboardChromiumLayoutHost({ ...base, capturePageUrl: "http://x", timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});

// ---------------------------------------------------------------------------
// 真实 Chrome 集成验证:仅在设置 BIM_STUDIO_CHROME_PATH 时运行。
// 捕获页与 verify 脚本同源(apps/web fixture 经 esbuild 打包由宿主自行托管);
// 字体取本地系统字体做真实 FontFace 注入,仅本地验证,不随包交付。
// ---------------------------------------------------------------------------
const chromePath = process.env.BIM_STUDIO_CHROME_PATH;
const integrationEntry = fileURLToPath(new URL("../../web/scripts/fixtures/dashboardTrustedLayoutCapture.tsx", import.meta.url));
const integrationFont = process.env.DASHBOARD_TRUSTED_LAYOUT_FONT
  ?? ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf"].find(candidate => existsSync(candidate));

describe.skipIf(!chromePath || !existsSync(integrationEntry))("dashboard chromium layout host with real Chrome", () => {
  let host: DashboardChromiumLayoutHost;
  beforeAll(() => {
    host = createDashboardChromiumLayoutHost({
      id: "chromium-layout-host-it", version: "1.0.0-it", chromePath: chromePath!, capturePageEntry: integrationEntry,
    });
  });
  afterAll(async () => { await host.close(); });

  async function freezeCandidate(fontBytes: Uint8Array) {
    const document: unknown = structuredClone(source);
    assertDashboardDocument(document);
    const typed = document as DashboardDocument;
    typed.application.scripts = [];
    typed.application.pages[0]!.nodes = [{ id: "widget-value", kind: "data-widget", zIndex: 3,
      frame: { x: 20, y: 30, width: 320, height: 120 },
      widget: { type: "value", title: "有功功率", key: "temperature", unit: "MW", source: "sample", color: "#ffffff" } }] as never;
    const metric = { value: 42, samples: [{ time: 1, value: 42 }] };
    return prepareDashboardPublicationFreeze({
      expected: { projectId: "project-golden", applicationId: "application-worker-behavior",
        publicationId: "publication-chromium-host", applicationRevision: 1 },
      entryPageId: "page-main",
      data: [{ id: dashboardDataRequestId("widget-value"), nodeId: "widget-value", sourceRevision: "sample:e2e" }],
      resources: [{ id: "font-main", kind: "font", objectKey: "projects/project-golden/assets/font-main.ttf",
        mime: "font/ttf", nodeIds: ["widget-value"], revision: 3, faceIndex: 0,
        license: { redistributable: true, evidence: "local-verification:system-font; never shipped" } }],
      readAuthority: async () => ({ activePublicationId: "publication-chromium-host", currentApplicationRevision: 1,
        publication: { id: "publication-chromium-host", projectId: "project-golden", applicationId: "application-worker-behavior",
          applicationRevision: 1, document: typed.application, publishedAt: "2026-09-17T00:00:00.000Z" } }),
      resolveData: async () => ({ sourceRevision: "sample:e2e", value: {
        source: { kind: "sample", id: "sample:widget-value", revision: 1, contentSha256: dashboardCanonicalJsonSha256(metric) },
        metric } }),
      readResource: async () => ({ revision: 3, bytes: fontBytes }),
    });
  }

  it.skipIf(!integrationFont)("measures a real value widget with injected font bytes and repeats the identical layout hash",
    { timeout: 300_000 }, async () => {
      const candidate = await freezeCandidate(new Uint8Array(await readFile(integrationFont!)));
      const record = await captureDashboardMeasuredLayout({ candidate, nodeId: "widget-value", host, locale: "zh-CN" });
      verifyDashboardMeasuredLayout(record, candidate);
      expect(record.logicalSize).toEqual([320, 120]);
      expect(record.layout.textBoxes.some(box => (box.role as { kind: string }).kind === "value")).toBe(true);
      expect(record.host.executableSha256).toMatch(/^[a-f0-9]{64}$/);
      const repeat = await captureDashboardMeasuredLayout({ candidate, nodeId: "widget-value", host, locale: "zh-CN" });
      expect(repeat.layoutSha256).toBe(record.layoutSha256);
    });

  it("rejects invalid frozen font bytes instead of measuring fallback geometry", { timeout: 300_000 }, async () => {
    const candidate = await freezeCandidate(new Uint8Array([1, 2, 3]));
    await expect(captureDashboardMeasuredLayout({ candidate, nodeId: "widget-value", host, locale: "zh-CN" }))
      .rejects.toBeInstanceOf(DashboardLayoutFontMissingError);
  });
});
