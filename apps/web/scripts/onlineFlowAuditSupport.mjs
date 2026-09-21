import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  assessOnlineFlowVisualEvidence,
  collectOnlineFlowVisualEvidence,
  ONLINE_FLOW_VISUAL_POLICY,
  ONLINE_FLOW_VISUAL_SELECTORS,
} from "./onlineFlowVisualQuality.mjs";

export function recordStep(target, name, evidence) {
  target.steps.push({ name, evidence, completedAt: new Date().toISOString() });
}

export async function auditKeyboardNavigation(page, id) {
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  const targets = [];
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    targets.push(await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return { identity: "none", visibleFocus: false };
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const identity = `${element.tagName.toLowerCase()}.${String(element.className || "").split(" ")[0]}[${element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent?.trim().slice(0, 18) ?? ""}]`;
      return {
        identity,
        visibleFocus: bounds.width > 0 && bounds.height > 0
          && (Number.parseFloat(style.outlineWidth) >= 1 || (style.boxShadow !== "none" && style.boxShadow !== ""))
      };
    }));
  }
  return {
    id,
    uniqueTargets: new Set(targets.map((target) => target.identity).filter((identity) => identity !== "none")).size,
    visibleFocusTargets: targets.filter((target) => target.visibleFocus).length,
    targets
  };
}

export function applicationPageUrl(origin, projectId, application) {
  const pageId = application.pages?.[0]?.id;
  if (!pageId) throw new Error("应用缺少二维页面");
  return `${origin}/studio/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(application.metadata.id)}/pages/${encodeURIComponent(pageId)}`;
}

export async function waitForModelReady(page, projectId, modelId) {
  await page.waitForFunction(async ({ requestedProjectId, requestedModelId }) => {
    const token = localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token");
    const response = await fetch(`/api/projects/${encodeURIComponent(requestedProjectId)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    if (!response.ok) return false;
    const project = await response.json();
    const model = project.models?.find((candidate) => candidate.id === requestedModelId);
    if (model?.status === "failed") throw new Error(`模型处理失败：${model.message}`);
    return model?.status === "ready";
  }, { requestedProjectId: projectId, requestedModelId: modelId }, { timeout: 30_000 });
}

export function writeMinimalGltf(filePath) {
  const positions = Buffer.from(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1.6, 0]).buffer);
  const indices = Buffer.from(new Uint16Array([0, 1, 2]).buffer);
  const binary = Buffer.concat([positions, indices]);
  const document = {
    asset: { version: "2.0", generator: "DeepMonkey Studio online flow gate" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Online flow triangle" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
      { buffer: 0, byteOffset: positions.length, byteLength: indices.length, target: 34963 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, 0], max: [1, 1.6, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }
    ]
  };
  writeFileSync(filePath, `${JSON.stringify(document)}\n`, "utf8");
}

export async function auditPage(page, id) {
  const [layout, visualEvidence] = await Promise.all([
    page.evaluate(() => ({
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
      documentScrollLeft: document.documentElement.scrollLeft || document.body.scrollLeft || 0,
      appShellLeft: document.querySelector(".app-shell")?.getBoundingClientRect().left ?? 0,
    })),
    page.evaluate(collectOnlineFlowVisualEvidence, {
      rootSelector: "body",
      policy: ONLINE_FLOW_VISUAL_POLICY,
      selectors: ONLINE_FLOW_VISUAL_SELECTORS,
    }),
  ]);
  const quality = assessOnlineFlowVisualEvidence(visualEvidence, id);
  return {
    id,
    ...layout,
    ...visualEvidence,
    smallTextDetails: visualEvidence.smallText,
    smallText: visualEvidence.smallText.map(formatVisualEvidence),
    smallTargetDetails: visualEvidence.smallTargets,
    smallTargets: visualEvidence.smallTargets.map(formatVisualEvidence),
    qualityFailures: quality.failures,
    qualityAdvisories: quality.advisories,
  };
}

function formatVisualEvidence(item) {
  if (Number.isFinite(item.fontSize)) return `${item.identity} ${item.fontSize}px < ${item.minimum}px`;
  if (Number.isFinite(item.width) && Number.isFinite(item.height)) return `${item.identity} ${item.width}×${item.height}px`;
  return item.identity;
}

export async function auditDeliveryFlow(page, projectId) {
  return page.evaluate((requestedProjectId) => {
    const flow = document.querySelector(".project-delivery-flow");
    const buttons = [...(flow?.querySelectorAll("button[data-step-id]") ?? [])];
    const storageKey = `bim-studio.delivery-workflow.v1:${requestedProjectId}`;
    let persistedStep;
    try {
      const raw = localStorage.getItem(storageKey);
      persistedStep = raw ? JSON.parse(raw)?.activeStep : undefined;
    } catch {
      // 门禁只读取导航记忆；存储损坏由应用自身的容错逻辑处理。
    }
    return {
      stepCount: buttons.length,
      stepIds: buttons.map((button) => button.getAttribute("data-step-id")),
      activeStep: buttons.find((button) => button.getAttribute("aria-current") === "step")?.getAttribute("data-step-id"),
      persistedStep,
      previousStep: (() => {
        try {
          const raw = localStorage.getItem(storageKey);
          return raw ? JSON.parse(raw)?.previousStep : undefined;
        } catch {
          return undefined;
        }
      })(),
      blockerCount: flow?.querySelectorAll(".delivery-blockers button").length ?? 0,
      progressLabel: flow?.querySelector(".delivery-progress")?.getAttribute("aria-label")
    };
  }, projectId);
}

export async function readJsonResponse(responsePromise, expectedStatus) {
  const response = await responsePromise;
  if (response.status() !== expectedStatus) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 800);
    } catch {
      detail = "无法读取响应正文";
    }
    throw new Error(`${response.request().method()} ${response.url()} 返回 HTTP ${response.status()}：${detail}`);
  }
  return response.json();
}

export async function showFlatSceneObjects(page) {
  if (await page.locator(".asset-row").count()) return;
  const organizationToggle = page.getByRole("button", { name: "场景图层与编组" });
  if (await organizationToggle.count() && (await organizationToggle.getAttribute("class"))?.includes("active")) await organizationToggle.click();
  const resourceToggle = page.getByRole("button", { name: "项目资源" });
  if (await resourceToggle.count() && (await resourceToggle.getAttribute("class"))?.includes("active")) await resourceToggle.click();
  await page.locator(".asset-list").waitFor({ state: "visible", timeout: 30_000 });
}

export function captureProcessOutput(stream, target) {
  stream?.on("data", (chunk) => target.push(...chunk.toString().split(/\r?\n/).filter(Boolean)));
}

export async function waitForHealth(url, processHandle) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`API 提前退出：${processHandle.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // API 启动期间连接失败是预期状态，直到超时才视为错误。
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error("API 在 30 秒内未就绪");
}

export async function reservePort() {
  const probe = createServer();
  await new Promise((resolveReady) => probe.listen(0, "127.0.0.1", resolveReady));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("无法分配 API 端口");
  await new Promise((resolveClosed) => probe.close(resolveClosed));
  return address.port;
}
