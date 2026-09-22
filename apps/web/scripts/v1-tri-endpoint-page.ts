// V1 三端同内容对拍的浏览器侧宿主（Web headless Chrome 与 Three WebView 共用同一页面）：
// 真实 ViewerEngine（WebGL 或 WebGPU）消费与 Deep Native 完全相同的冻结 runtime package——
// 先 parseDeepRuntimePackage 做包合同校验（packageId/packageHash 链），再以同一场景快照
// 进入真实渲染循环；凑满 N 个真实 presentation 帧后通过 window.result 交回证据。
// 页面不做任何画质折衷：backend 由查询参数显式指定，失败就 fail loud，不静默回退。
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, type DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { applySceneViewerSnapshot } from "../src/delivery/applySceneViewerSnapshot";
import { ViewerEngine } from "../src/viewer/ViewerEngine";

declare global {
  interface Window {
    result?: unknown;
    failure?: string;
    /** runner 注入的冻结运行包 JSON（与 Native 端字节相同）。 */
    frozenPackageJson?: string;
    /** runner 注入的场景快照 JSON（运行包的同一编译来源）。 */
    sceneSnapshotJson?: string;
    /** runner 注入的目标帧数（1..120）。 */
    frameTarget?: string;
  }
}

(async () => {
  try {
    const backend = new URLSearchParams(window.location.search).get("backend") === "webgpu" ? "webgpu" : "webgl";
    const frameTarget = Math.max(1, Math.min(120, Number(window.frameTarget ?? "8") || 8));
    // 包合同校验：无效包直接失败，绝不带着坏内容渲染。
    const frozen = parseDeepRuntimePackage(window.frozenPackageJson ?? "") as { valid: true; value: DeepRuntimePackage } | { valid: false };
    if (!frozen.valid) throw new Error("冻结运行包 JSON 校验失败");
    const runtimePackage = frozen.value;
    const snapshot = JSON.parse(window.sceneSnapshotJson ?? "") as SceneSnapshot;

    // 渲染环境探测（独立于引擎，仅供能力矩阵记录渲染后端信息，不参与画面判定）。
    const environmentProbe = await probeRenderEnvironment();

    const viewport = document.getElementById("viewport")!;
    const engine = await ViewerEngine.create(viewport, backend);
    // 与发布查看器同一条消费路径：快照进真实引擎场景图。
    await applySceneViewerSnapshot(engine, snapshot, { id: "v1-tri-endpoint", models: [] } as never, {});
    engine.setContinuousRender("v1-tri-endpoint", true);

    const presentations: Array<{ frame: number; elapsedMs: number; drawCalls: number | null }> = [];
    const startedAt = performance.now();
    const unsubscribe = engine.subscribePresentationFrames(() => {
      const info = (engine.getRawRenderer() as unknown as { info?: { render?: { calls?: number; drawCalls?: number } } }).info;
      presentations.push({
        frame: presentations.length + 1,
        elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        drawCalls: info?.render?.calls ?? info?.render?.drawCalls ?? null,
      });
      if (presentations.length >= frameTarget) {
        // 连续渲染保持开启：取证截图取的是凑满 N 帧之后的真实画布内容。
        unsubscribe();
        window.result = {
          backend, frameTarget, frames: presentations.length, presentations, environmentProbe,
          packageId: runtimePackage.packageId, packageHash: runtimePackage.packageHash.value,
        };
      }
    });
  } catch (error) {
    window.failure = String(error);
  }
})();

/** 独立探测本渲染环境的 WebGL/WebGPU 信息（仅记录，不替代引擎自身的后端决定）。 */
async function probeRenderEnvironment(): Promise<unknown> {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    let webglRenderer: string | null = null;
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      webglRenderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    }
    let webgpuAdapter: unknown = null;
    if ("gpu" in navigator) {
      try {
        const adapter = await (navigator as Navigator & { gpu: { requestAdapter(): Promise<{ info?: unknown } | null> } }).gpu.requestAdapter();
        webgpuAdapter = adapter ? (adapter.info ?? { available: true, infoUnavailable: true }) : { available: false };
      } catch (error) {
        webgpuAdapter = { available: false, error: String(error) };
      }
    }
    return { webglRenderer, webgpuAdapter };
  } catch (error) {
    return { probeError: String(error) };
  }
}
