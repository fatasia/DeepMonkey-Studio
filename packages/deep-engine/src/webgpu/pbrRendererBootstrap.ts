import { DeviceSession } from "./deviceSession.js";
import { LocalSpotShadowRuntime } from "./localSpotShadowRuntime.js";
import { ForwardPlusPbrRuntime } from "../lighting/forwardPlusPbrRuntime.js";
import { createPbrPipelineSet } from "./pbrPipelineSet.js";
import { createPbrEnvironment } from "./pbrEnvironmentSource.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatures } from "./pbrRendererFeatures.js";
import type { Pipelines } from "./pipelines.js";
import { pipelineWarmupEntriesFromLedger, persistPipelineWarmupPlanToBrowser } from "./pipelineCachePersistence.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import type { PbrRendererOptions } from "./pbrRendererTypes.js";
import { assertTextureArrayProductionReady } from "./textureArrayProductionGate.js";
import { probePbrMainSampleCount, type PbrMsaaCapability } from "./pbrMsaaCapability.js";
import { resolvePbrMsaaSampleCount } from "./renderTargets.js";

/** Owns bootstrap error scopes and cancellation; the renderer owns successfully prepared resources. */
export async function openPbrRenderer<T>(session: DeviceSession,
  signal: AbortSignal, options: PbrRendererOptions, abortError: () => Error,
  create: (session: DeviceSession, pipelines: Pipelines, environment: StudioEnvironment,
    lighting: ForwardPlusPbrRuntime, shadows: LocalSpotShadowRuntime, options: PbrRendererOptions,
    features: PbrRendererFeatures, deformation?: Pipelines | Promise<Pipelines>,
    releasePipelines?: () => void, msaa?: PbrMsaaCapability) => T): Promise<T> {
  const cancel = (): void => session.dispose();
  let scopeOpen = false;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw abortError();
    let features = resolvePbrRendererFeatures(options.features);
    assertTextureArrayProductionReady(features);
    // AA-M1 能力探针必须在 bootstrap 校验作用域之前运行(popErrorScope 弹出最近作用域);
    // 设备不支持 4x 时 fail-closed 回 1x,原因随渲染器披露(FrameMetrics.msaa)。
    const msaa = await probePbrMainSampleCount(session.device, resolvePbrMsaaSampleCount(options.msaaSampleCount));
    // AA-M1:MSAA 激活即取代 legacy spatialAa 作为空间域 AA。证据(parity aa-bloom,
    // 2026-10-04):Deep MSAA4+spatialAa RMSE 8.17 比 1x+spatialAa 的 6.05 更差 —— legacy
    // 边缘算法叠加在已多采样平滑的边缘上属过度处理。M2 以 SMAA 回归显示域兜底档。
    if (msaa.sampleCount > 1 && features.spatialAa) {
      features = Object.freeze({ ...features, spatialAa: false });
    }
    // 管线集合按解析后的采样数构建(缓存键含采样数),渲染器与目标同源。
    const pipelineOptions: PbrRendererOptions = msaa.sampleCount === 4
      ? options : { ...options, msaaSampleCount: 1 };
    session.device.pushErrorScope("validation"); scopeOpen = true;
    markBootstrap("local-shadows-start");
    // F7b：档位第三参贯通(opt-in,缺省 standard = 既有调用语义逐位不变)。
    const localShadows = await LocalSpotShadowRuntime.create(session, signal,
      options.localSpotShadowAtlasTier ?? "standard"), lighting = new ForwardPlusPbrRuntime(session, localShadows.bindings);
    markBootstrap("local-shadows-ready");
    markBootstrap("pipeline-env-start");
    const deferDeformation = options.pipelines?.deferDeformation === true
      && options.deformation === true;
    // 未启用任何时序开关时保持旧语义：全量变体（含 deformation）就绪后才继续。
    const legacyAwaitAll = options.pipelines?.firstFrameMainKeys === undefined && !deferDeformation;
    const [set, environment] = await Promise.all([
      createPbrPipelineSet(session, lighting.layout, pipelineOptions, features).then(async value => {
        // 未启用时序开关：全量变体（含 deformation）就绪后才继续（旧语义）。
        // 启用时只等首帧关键子集，剩余变体在作用域关闭后于背景排队。
        if (legacyAwaitAll) {
          await value.ready;
          await value.deformation;
        } else {
          await value.criticalReady;
        }
        markBootstrap(options.pipelines?.firstFrameMainKeys ? "pipelines-critical-ready" : "pipelines-ready");
        // C26:把逐管线编译清单(指纹+耗时+关键子集分类)落盘为跨会话预热计划。
        // fail-open:存储不可用只损失下一次会话的优先级建议,绝不影响启动。
        try {
          void persistPipelineWarmupPlanToBrowser(
            pipelineWarmupEntriesFromLedger(value.pipelineCompileRecords(), value.criticalFingerprints));
        } catch { /* 量化辅助路径 */ }
        return value;
      }),
      createPbrEnvironment(session, options.environment, signal).then(value => {
        markBootstrap("gpu-environment-ready"); return value;
      }),
    ]);
    if (signal.aborted || session.state !== "ready") throw new Error("GPU preparation interrupted.");
    // 校验作用域在此关闭：其内的阴影/关键管线错误照旧拦截首帧。剩余 main 变体与
    // 延迟 deformation 变体保持待命，宿主在首帧验证通过后调用 release 才开始排队，
    // 背景编译不再与上传/首帧验证争抢设备。startDeformation 立即返回就绪 promise
    //（门禁可在发布后等待），其内部创建被同一 release 门挡住。
    const pendingError = session.device.popErrorScope(); scopeOpen = false;
    const error = await pendingError;
    if (error) throw new Error(error.message);
    const deferredDeformation = deferDeformation ? set.startDeformation?.() : undefined;
    const renderer = create(session, set.pipelines, environment, lighting, localShadows, options, features,
      deferDeformation ? deferredDeformation : set.deformation, set.release, msaa);
    markBootstrap("bootstrap-created");
    markBootstrap("bootstrap-errors-cleared");
    return renderer;
  } catch (error) {
    if (scopeOpen) try { await session.device.popErrorScope(); } catch { /* device loss owns diagnostics */ }
    session.dispose(); throw error;
  }
  finally { signal.removeEventListener("abort", cancel); }
}

function markBootstrap(name: string): void {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(`deep-webgpu:${name}`);
  }
}
