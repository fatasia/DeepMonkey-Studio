// R3 状态操作序列跨端确定性重放的 Web 侧宿主:真实 ViewerEngine(WebGL 或
// WebGPU)+ 真实 presentation frame scheduler。每个合同步骤经真实引擎路径
// 应用(setClipping / select),再从引擎回读状态并按合同归一,得到 applied
// 帧;canonical 帧由本端合同实现独立折叠。两者逐字节相等才进入回执,这也是
// 跨端(Native)对比的输入。
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, type DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import {
  canonicalR3StateFrame,
  clipFieldFromClippingState,
  clippingStateForContract,
  parseR3StateOps,
  type R3StateOps,
} from "../src/delivery/r3StateFrame";
import { applySceneViewerSnapshot } from "../src/delivery/applySceneViewerSnapshot";
import { ViewerEngine } from "../src/viewer/ViewerEngine";

declare global {
  interface Window {
    result?: unknown;
    failure?: string;
    frozenPackageJson?: string;
    sceneSnapshotJson?: string;
    stateOpsJson?: string;
  }
}

interface ReplayEvent { readonly revision: number; readonly timeMs: number }

function replayRevisionsAt(runtimePackage: DeepRuntimePackage, atMs: number): number[] {
  const id = runtimePackage.entrypoints.dynamicRuntime;
  if (!id) return [];
  const payload = runtimePackage.payloads[id] as { dataReplay?: { events?: ReplayEvent[] } } | undefined;
  return (payload?.dataReplay?.events ?? []).filter(event => event.timeMs <= atMs).map(event => event.revision);
}

(async () => {
  try {
    const backend = new URLSearchParams(window.location.search).get("backend") === "webgpu" ? "webgpu" : "webgl";
    const frozen = parseDeepRuntimePackage(window.frozenPackageJson ?? "") as { valid: true; value: DeepRuntimePackage } | { valid: false };
    if (!frozen.valid) throw new Error("frozen runtime package JSON failed validation");
    const snapshot = JSON.parse(window.sceneSnapshotJson ?? "") as SceneSnapshot;
    const ops: R3StateOps = parseR3StateOps(JSON.parse(window.stateOpsJson ?? ""));

    const viewport = document.getElementById("viewport")!;
    const engine = await ViewerEngine.create(viewport, backend);
    await applySceneViewerSnapshot(engine, snapshot, { id: "replay", models: [] } as never, {});
    engine.setContinuousRender("r3-state-replay", true);

    const startedAt = performance.now();
    const steps: Array<{ index: number; atMs: number; canonical: string; applied: string }> = [];
    const presentations: Array<{ frame: number; elapsedMs: number; appliedSteps: number; drawCalls: number | null }> = [];
    let nextStep = 0;
    let settledFrames = 0;

    const unsubscribe = engine.subscribePresentationFrames(() => {
      const elapsed = performance.now() - startedAt;
      try {
        while (nextStep < ops.steps.length) {
          const stepIndex = nextStep;
          const atMs = ops.steps[stepIndex]!.atMs;
          if (atMs > elapsed) break;
          // 合同期望帧:本端合同实现独立折叠(events 同样从本端包解析采样)。
          const frame = canonicalR3StateFrame(ops, stepIndex, replayRevisionsAt(frozen.value, atMs));
          // 真实消费路径:合同态经引擎公有 API 应用到运行时。
          const op = ops.steps[stepIndex]!.op;
          if (op.kind === "select") engine.select(op.targetId);
          else if (op.kind === "clear-selection") engine.select(undefined);
          else engine.setClipping(clippingStateForContract(frame.clip));
          // 回读归一:真实运行时状态 → 合同字段。
          const appliedClip = clipFieldFromClippingState(engine.getClippingState());
          const appliedSelection = engine.getSelected()?.id ?? null;
          const applied = `r3-state-frame-v1|i=${stepIndex}|t=${atMs}|clip=${appliedClip}|sel=${appliedSelection ?? "-"}|events=${frame.canonical.split("|events=")[1] ?? ""}`;
          if (applied !== frame.canonical) {
            throw new Error(`step ${stepIndex}: applied state diverged\n  contract: ${frame.canonical}\n  applied:  ${applied}`);
          }
          steps.push({ index: stepIndex, atMs, canonical: frame.canonical, applied });
          nextStep += 1;
        }
        const info = (engine.getRawRenderer() as unknown as { info?: { render?: { calls?: number; drawCalls?: number } } }).info;
        presentations.push({
          frame: presentations.length + 1,
          elapsedMs: Math.round(elapsed * 1000) / 1000,
          appliedSteps: nextStep,
          drawCalls: info?.render?.calls ?? info?.render?.drawCalls ?? null,
        });
        if (nextStep >= ops.steps.length) {
          settledFrames += 1;
          if (settledFrames >= 2) {
            unsubscribe();
            window.result = { backend, opsId: ops.id, steps, presentations };
          }
        }
      } catch (error) {
        unsubscribe();
        window.failure = String(error);
      }
    });
  } catch (error) {
    window.failure = String(error);
  }
})();
