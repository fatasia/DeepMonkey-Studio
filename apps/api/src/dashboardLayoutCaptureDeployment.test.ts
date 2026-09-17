import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDashboardLayoutCaptureDeployment,
  DASHBOARD_LAYOUT_CAPTURE_LOCALE } from "./dashboardLayoutCaptureDeployment.js";

/** 最小假产物:只用于验证托管内容与协议桥,真实 bundle 由构建脚本负责。 */
const fakeBundle = "globalThis.__DASHBOARD_LAYOUT_REQUEST__=undefined;globalThis.captureDashboardHeading=()=>({layout:{}});";

async function capturePageDirectory(): Promise<{ directory: string; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-capture-deployment-"));
  await writeFile(path.join(directory, "layout-capture.js"), fakeBundle);
  await writeFile(path.join(directory, "layout-capture.css"), "#root{}");
  return { directory, dispose: () => rm(directory, { recursive: true, force: true }) };
}

async function fetchText(url: string, file: string): Promise<{ status: number; type: string; body: string }> {
  const response = await fetch(new URL(file, url));
  return { status: response.status, type: response.headers.get("content-type") ?? "", body: await response.text() };
}

describe("dashboard layout capture deployment", () => {
  it("fails fast with an actionable error when the Chromium executable is missing", async () => {
    const page = await capturePageDirectory();
    try {
      const absolute = path.join(tmpdir(), "dashboard-no-such-chrome.exe");
      await expect(createDashboardLayoutCaptureDeployment({ chromePath: absolute, capturePageDirectory: page.directory }))
        .rejects.toThrow(/Chromium executable not found/);
      await expect(createDashboardLayoutCaptureDeployment({ chromePath: "chrome.exe", capturePageDirectory: page.directory }))
        .rejects.toThrow(/absolute chromePath/);
      await expect(createDashboardLayoutCaptureDeployment({ chromePath: process.execPath, capturePageDirectory: "dist" }))
        .rejects.toThrow(/absolute capturePageDirectory/);
    } finally {
      await page.dispose();
    }
  });

  it("fails fast when the capture page directory does not carry the built bundle", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "dashboard-capture-empty-"));
    try {
      await expect(createDashboardLayoutCaptureDeployment({ chromePath: process.execPath, capturePageDirectory: empty }))
        .rejects.toThrow(/build-dashboard-content-compiler\.mjs/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("hosts the deployed capture page behind the API host protocol bridge and closes idempotently", async () => {
    const page = await capturePageDirectory();
    const deployment = await createDashboardLayoutCaptureDeployment({ chromePath: process.execPath,
      capturePageDirectory: page.directory, timeoutMs: 5_000 });
    try {
      expect(deployment.locale).toBe(DASHBOARD_LAYOUT_CAPTURE_LOCALE);
      expect(deployment.host.id).toBe("dashboard-chromium-layout-host");
      expect(deployment.capturePageUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const index = await fetchText(deployment.capturePageUrl, "/");
      expect(index).toMatchObject({ status: 200, type: "text/html" });
      expect(index.body).toContain('<script type="module" src="/layout-capture.js">');
      const script = await fetchText(deployment.capturePageUrl, "/layout-capture.js");
      expect(script).toMatchObject({ status: 200, type: "text/javascript" });
      // 协议桥:__LAYOUT_REQUEST__ → 页面全局名;captureWidget → heading 入口;错误通道 fail-closed。
      expect(script.body).toContain("__DASHBOARD_LAYOUT_REQUEST__={...r,locale:\"zh-CN\"}");
      expect(script.body).toContain("globalThis.captureWidget=");
      expect(script.body).toContain("__DASHBOARD_LAYOUT_ERROR__");
      expect(script.body).toContain(fakeBundle);
      const stylesheet = await fetchText(deployment.capturePageUrl, "/layout-capture.css");
      expect(stylesheet).toMatchObject({ status: 200, type: "text/css", body: "#root{}" });
      expect((await fetchText(deployment.capturePageUrl, "/no-such.js")).status).toBe(404);
    } finally {
      await deployment.close();
      await deployment.close(); // 幂等
      await page.dispose();
    }
    await expect(fetchText(deployment.capturePageUrl, "/")).rejects.toThrow();
  });

  it("keeps serving a deployment without a stylesheet", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dashboard-capture-nocss-"));
    await writeFile(path.join(directory, "layout-capture.js"), fakeBundle);
    const deployment = await createDashboardLayoutCaptureDeployment({ chromePath: process.execPath,
      capturePageDirectory: directory });
    try {
      expect((await fetchText(deployment.capturePageUrl, "/layout-capture.css")).status).toBe(404);
    } finally {
      await deployment.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads back the real built capture page bundle when the deployment output exists", async () => {
    const built = path.resolve(fileURLToPath(new URL("../dist/dashboard-content-compiler", import.meta.url)));
    const bundle = path.join(built, "layout-capture.js");
    const deployment = await createDashboardLayoutCaptureDeployment({ chromePath: process.execPath,
      capturePageDirectory: built }).catch(() => null);
    if (!deployment) return; // 未构建时跳过(生产分发不属本切片)
    try {
      const script = await fetchText(deployment.capturePageUrl, "/layout-capture.js");
      expect(script.body).toContain(await readFile(bundle, "utf8"));
    } finally {
      await deployment.close();
    }
  });
});
