// 动态运行包跨端确定性重放的 Web 侧宿主:真实 ViewerEngine(WebGL 或 WebGPU)+
// 真实 presentation frame scheduler,消费与 Native 完全相同的冻结 v7 runtime package。
// 播放循环由真实浏览器帧驱动;确定性来自固定步长网格——真实时钟只决定每个确定性
// 步何时被应用,不改变采样结果。canonical 帧字符串即跨端字节合同。
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, type DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { canonicalDynamicRuntimeFrame } from "../src/delivery/dynamicRuntimePlayback";
import { applySceneViewerSnapshot } from "../src/delivery/applySceneViewerSnapshot";
import { ViewerEngine } from "../src/viewer/ViewerEngine";

declare global {
  interface Window {
    result?: unknown;
    failure?: string;
    frozenPackageJson?: string;
    sceneSnapshotJson?: string;
    replayConfigJson?: string;
  }
}

interface ReplayConfig { stepMs: number; steps: number }

(async () => {
  try {
    const backend = new URLSearchParams(window.location.search).get("backend") === "webgpu" ? "webgpu" : "webgl";
    const frozen = parseDeepRuntimePackage(window.frozenPackageJson ?? "") as { valid: true; value: DeepRuntimePackage } | { valid: false };
    if (!frozen.valid) throw new Error("frozen runtime package JSON failed validation");
    const snapshot = JSON.parse(window.sceneSnapshotJson ?? "") as SceneSnapshot;
    const config = JSON.parse(window.replayConfigJson ?? "") as ReplayConfig;
    const runtimePackage = frozen.value;
    const durationMs = Number((runtimePackage.payloads[runtimePackage.entrypoints.dynamicRuntime ?? ""] as { animation?: { durationMs?: number } } | undefined)?.animation?.durationMs ?? 0);
    if (!durationMs) throw new Error("frozen package has no animation duration");
    if (config.steps !== Math.floor(durationMs / config.stepMs) + 1) {
      throw new Error(`step grid mismatch: ${config.steps} vs duration ${durationMs}`);
    }

    const viewport = document.getElementById("viewport")!;
    const engine = await ViewerEngine.create(viewport, backend);
    await applySceneViewerSnapshot(engine, snapshot, { id: "replay", models: [] } as never, {});
    engine.setContinuousRender("dynamic-runtime-replay", true);

    const startedAt = performance.now();
    const steps: Array<{ timeMs: number; canonical: string }> = [];
    const presentations: Array<{ frame: number; elapsedMs: number; appliedSteps: number; drawCalls: number | null }> = [];
    let nextStep = 0;
    let settledFrames = 0;

    const unsubscribe = engine.subscribePresentationFrames(() => {
      const elapsed = performance.now() - startedAt;
      let applied = 0;
      while (nextStep < config.steps) {
        const stepTime = Math.min(nextStep * config.stepMs, durationMs);
        if (stepTime > elapsed) break;
        // 真实消费路径:采样后的帧直接应用到引擎场景对象(渲染提交由本帧自然发生)。
        engine.applyDynamicRuntimeFrame(runtimePackage, stepTime);
        steps.push({ timeMs: stepTime, canonical: canonicalDynamicRuntimeFrame(runtimePackage, stepTime).canonical });
        nextStep += 1;
        applied += 1;
      }
      const info = (engine.getRawRenderer() as unknown as { info?: { render?: { calls?: number; drawCalls?: number } } }).info;
      presentations.push({
        frame: presentations.length + 1,
        elapsedMs: Math.round(elapsed * 1000) / 1000,
        appliedSteps: nextStep,
        drawCalls: info?.render?.calls ?? info?.render?.drawCalls ?? null,
      });
      if (nextStep >= config.steps) {
        // 最后一步已呈现:再留一帧确认末姿态后结束。
        settledFrames += 1;
        if (settledFrames >= 2) {
          unsubscribe();
          window.result = { backend, durationMs, stepMs: config.stepMs, steps, presentations };
        }
      }
    });
  } catch (error) {
    window.failure = String(error);
  }
})();
