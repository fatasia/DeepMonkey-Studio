import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { createDashboardChromiumLayoutHost,
  type DashboardChromiumLayoutHost } from "./dashboardLayoutCaptureHost.js";

/**
 * G04 收官:把 Chromium 布局宿主装配进 API 进程的生产组合件。
 *
 * 消费 scripts/build-dashboard-content-compiler.mjs 打出的捕获页目录
 * (dist/dashboard-content-compiler/layout-capture.js),由进程内 http 服务托管,
 * 以 capturePageUrl 模式构造 createDashboardChromiumLayoutHost。宿主浏览器惰性启动;
 * 可执行文件、捕获页产物与端口绑定在本模块装配时即校验,失败在服务器启动期暴露,
 * 不拖到首次捕获。
 *
 * 诚实边界:捕获页目录的生产分发(dist 进安装包)不属本切片;多轮捕获的
 * 内存/泄漏观测不做(宿主已有单轮隔离页测试)。
 */

/** 已验证捕获页固定以 zh-CN 渲染;宿主对其他 locale fail-closed,装配层同样只声明该 locale。 */
export const DASHBOARD_LAYOUT_CAPTURE_LOCALE = "zh-CN";
const HOST_ID = "dashboard-chromium-layout-host";
const HOST_VERSION = "1.0.0";
const CAPTURE_SCRIPT = "layout-capture.js";
const CAPTURE_STYLESHEET = "layout-capture.css";

export interface DashboardLayoutCaptureDeploymentOptions {
  readonly chromePath: string;
  /** scripts/build-dashboard-content-compiler.mjs 的输出目录(含 layout-capture.js)。 */
  readonly capturePageDirectory: string;
  readonly timeoutMs?: number;
}

export interface DashboardLayoutCaptureDeployment {
  readonly host: DashboardChromiumLayoutHost;
  readonly locale: string;
  readonly capturePageUrl: string;
  /** 关闭宿主浏览器与进程内捕获页服务;幂等。 */
  close(): Promise<void>;
}

export async function createDashboardLayoutCaptureDeployment(
  options: DashboardLayoutCaptureDeploymentOptions,
): Promise<DashboardLayoutCaptureDeployment> {
  if (!path.isAbsolute(options.chromePath)) {
    throw new Error("Dashboard layout capture requires an absolute chromePath");
  }
  if (!existsSync(options.chromePath)) {
    throw new Error(`Dashboard layout capture Chromium executable not found at ${options.chromePath};`
      + " point layoutCapture.chromePath (env BIM_STUDIO_CHROME_PATH) at a real Chrome/Chromium binary");
  }
  if (!path.isAbsolute(options.capturePageDirectory)) {
    throw new Error("Dashboard layout capture requires an absolute capturePageDirectory");
  }
  const bundled = await readFile(path.join(options.capturePageDirectory, CAPTURE_SCRIPT)).catch(() => {
    throw new Error(`Dashboard capture page directory ${options.capturePageDirectory} does not contain ${CAPTURE_SCRIPT};`
      + " run scripts/build-dashboard-content-compiler.mjs first");
  });
  const stylesheet = await readFile(path.join(options.capturePageDirectory, CAPTURE_STYLESHEET)).catch(() => null);
  const assets = new Map<string, { readonly body: Uint8Array; readonly type: string }>([
    ["/", { body: encodeText('<!doctype html><html><head><link rel="stylesheet" href="/layout-capture.css"></head>'
      + '<body><div id="root"></div><script type="module" src="/layout-capture.js"></script></body></html>'), type: "text/html" }],
    [CAPTURE_SCRIPT, { body: encodeText(withLayoutCaptureProtocolBridge(bundled)), type: "text/javascript" }],
    ...stylesheet ? [[CAPTURE_STYLESHEET, { body: encodeText(stylesheet), type: "text/css" }] as const] : [],
  ]);
  const server = createServer((request, response) => {
    const name = request.url === "/" ? "/" : (request.url ?? "").slice(1);
    const asset = assets.get(name);
    if (!asset) { response.writeHead(404).end(); return; }
    // content-type 三分支:html 被当作 text/javascript 时 Chromium 会把源码渲染成纯文本页。
    response.setHeader("content-type", asset.type);
    response.end(asset.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Dashboard capture page server did not bind a TCP port");
  }
  const capturePageUrl = `http://127.0.0.1:${address.port}/`;
  const host = createDashboardChromiumLayoutHost({
    id: HOST_ID, version: HOST_VERSION, chromePath: options.chromePath, capturePageUrl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    host, locale: DASHBOARD_LAYOUT_CAPTURE_LOCALE, capturePageUrl,
    close: async (): Promise<void> => {
      await Promise.allSettled([
        host.close(),
        new Promise<void>(resolve => { server.close(() => resolve()); }),
      ]);
    },
  };
}

/**
 * 部署捕获页由 heading 链打包(全局名 `__DASHBOARD_LAYOUT_REQUEST__` / `captureDashboardHeading`,
 * 错误通道 `__DASHBOARD_LAYOUT_ERROR__`),而 API 宿主合同是 `__LAYOUT_REQUEST__` / `captureWidget` /
 * `__FONT_ERRORS__`。这里在托管时包一层协议桥并轨两套全局名,不改已验证的捕获页源与 scripts 链。
 * 字体失败仍 fail-closed:页面自身的 `__DASHBOARD_LAYOUT_ERROR__`、等比检查与冻结字体绑定检查
 * 会拒绝无效字体,宿主在 captureWidget 阶段收到错误。
 */
function withLayoutCaptureProtocolBridge(bundled: Uint8Array): string {
  const prologue = "globalThis.__FONT_ERRORS__=[];"
    + "(()=>{const r=globalThis.__LAYOUT_REQUEST__;"
    + "if(r)globalThis.__DASHBOARD_LAYOUT_REQUEST__={...r,locale:\"zh-CN\"};})();";
  const epilogue = ";globalThis.captureWidget=()=>{"
    + "if(globalThis.__DASHBOARD_LAYOUT_ERROR__)throw new Error(globalThis.__DASHBOARD_LAYOUT_ERROR__);"
    + "if(typeof globalThis.captureDashboardHeading!==\"function\")throw new Error(\"Dashboard capture page did not mount\");"
    + "return globalThis.captureDashboardHeading();};";
  return `${prologue}${new TextDecoder().decode(bundled)}${epilogue}`;
}

function encodeText(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}
