import type { DeviceSession } from "./deviceSession.js";
import type { PbrRendererOptions } from "./pbrRendererTypes.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { createPipelinesBuild, type Pipelines, type PipelinesBuild } from "./pipelines.js";
import type { PipelineCompileRecord } from "./pipelineCache.js";

const PIPELINE_SET_SCHEMA = "deep-pbr-pso-v2-reflection-probes";

/** 静态材质 ABI 保持原布局；变形使用单独的 storage 顶点管线。 */
export interface PbrPipelineSet {
  readonly pipelines: Pipelines;
  /** 首帧关键子集（关键 main + 全部阴影/输出）就绪；openPbrRenderer 只等待它。 */
  readonly criticalReady: Promise<void>;
  /** 全部静态变体就绪；失败向所有等待方传播。 */
  readonly ready: Promise<void>;
  /** 关闭 bootstrap 校验作用域后调用，允许背景 main 变体排队。 */
  readonly release: () => void;
  /** C26 量化口径:本 device 的逐管线编译耗时清单(静态变体构建)。 */
  readonly pipelineCompileRecords: () => readonly PipelineCompileRecord[];
  /** 首帧关键子集管线指纹(跨会话预热计划分类依据)。 */
  readonly criticalFingerprints: readonly string[];
  /** deformation 变体未延迟时在此就绪；延迟模式下为 undefined。 */
  readonly deformation?: Promise<Pipelines>;
  /** deferDeformation 模式下首次调用才开始创建变形变体（幂等）。 */
  readonly startDeformation?: () => Promise<Pipelines>;
}

type PbrPipelineSetBuild = Awaited<ReturnType<typeof buildPbrPipelineSet>>;
const pipelineSets = new WeakMap<GPUDevice,
  WeakMap<GPUBindGroupLayout, Map<string, Promise<PbrPipelineSetBuild>>>>();

/** Explicit device-loss/test invalidation; normal device collection is weak. */
export function clearPbrPipelineSetCache(device: GPUDevice): void { pipelineSets.delete(device); }

/** 变体选择与缓存键同旧实现一致；defer/子集只改变等待时序，不改变集合内容，
 * 因此同一 device 上的两种时序共享同一缓存条目（生产中每 device 只有一种模式）。 */
export async function createPbrPipelineSet(session: DeviceSession, lightingLayout: GPUBindGroupLayout,
  options: PbrRendererOptions, features: PbrRendererFeatures): Promise<PbrPipelineSetBuild> {
  if (options.deformation !== undefined && typeof options.deformation !== "boolean")
    throw new TypeError("PBR deformation capability must be boolean.");
  if (options.meshlets !== undefined && typeof options.meshlets !== "boolean") throw new TypeError("PBR meshlets capability must be boolean.");
  const writeGeometry = features.ambientOcclusion || features.screenSpaceReflection || features.volumetricFog || features.temporalAa || features.contactShadows
    || options.deformation === true;
  const directDisplay = !features.environment && !features.fog && !features.groundGrid;
  const oneCascade = options.shadows?.exactProfile?.cascadeCount === 1;
  let byLayout = pipelineSets.get(session.device);
  if (!byLayout) { byLayout = new WeakMap(); pipelineSets.set(session.device, byLayout); }
  let byVariant = byLayout.get(lightingLayout);
  if (!byVariant) { byVariant = new Map(); byLayout.set(lightingLayout, byVariant); }
  const key = [PIPELINE_SET_SCHEMA, session.format, writeGeometry ? 1 : 0, directDisplay ? 1 : 0,
    oneCascade ? 1 : 0, options.deformation === true ? 1 : 0, features.textureArrays ? 1 : 0].join("/");
  const existing = byVariant.get(key);
  if (existing) return existing;
  const created = buildPbrPipelineSet(session, lightingLayout, options, writeGeometry, directDisplay,
    oneCascade, features.textureArrays);
  byVariant.set(key, created);
  void created.catch(() => { if (byVariant!.get(key) === created) byVariant!.delete(key); });
  return created;
}

async function buildPbrPipelineSet(session: DeviceSession, lightingLayout: GPUBindGroupLayout,
  options: PbrRendererOptions, writeGeometry: boolean, directDisplay: boolean, oneCascade: boolean,
  textureArrays: boolean) {
  const firstFrameMainKeys = options.pipelines?.firstFrameMainKeys;
  const buildOptions = firstFrameMainKeys === undefined ? undefined : { firstFrameMainKeys };
  const wantsDeformation = options.deformation === true;
  const deferDeformation = wantsDeformation && options.pipelines?.deferDeformation === true;
  const [fallbackBuild, arrayBuild] = await Promise.all([
    createPipelinesBuild(session.device, session.format, lightingLayout, writeGeometry, directDisplay, oneCascade, buildOptions),
    textureArrays ? createPipelinesBuild(session.device, session.format, lightingLayout, writeGeometry,
      directDisplay, oneCascade, { ...buildOptions, textureArrays: true }) : undefined,
  ]);
  const criticalReady = Promise.all([fallbackBuild.criticalReady, ...(arrayBuild ? [arrayBuild.criticalReady] : [])])
    .then(() => undefined);
  const ready = Promise.all([fallbackBuild.ready, ...(arrayBuild ? [arrayBuild.ready] : [])])
    .then(() => undefined);
  const mergeSelected = (selected: PipelinesBuild | undefined, fallback: PipelinesBuild): Pipelines => {
    if (!selected) return fallback.pipelines;
    // 原型链委托保持增量填充语义；textureArrayFallback 为自有属性引用。
    const merged = Object.create(selected.pipelines) as Pipelines;
    (merged as { textureArrayFallback?: Pipelines }).textureArrayFallback = fallback.pipelines;
    return merged;
  };
  const pipelines = mergeSelected(arrayBuild, fallbackBuild);
  const deformationPipelines = (selected: PipelinesBuild | undefined,
    fallback: PipelinesBuild | undefined): Promise<Pipelines> | undefined => {
    if (!selected && !fallback) return undefined;
    const merged = Promise.all([selected?.ready, fallback?.ready].filter((value): value is Promise<void> => value !== undefined))
      .then(() => mergeSelected(selected, (fallback ?? selected)!));
    void merged.catch(() => { /* 由等待方（packet 门禁或 bootstrap）处置 */ });
    return merged;
  };
  const buildSet = (build: PipelinesBuild): PbrPipelineSet => ({
    pipelines, criticalReady, ready,
    release: () => build.releaseDeferredQueues(),
    pipelineCompileRecords: () => build.pipelineCompileRecords(),
    criticalFingerprints: build.criticalFingerprints,
  });
  // 非延迟模式：变形变体与其他变体同时开始创建（旧语义），set.ready 覆盖它们。
  if (!deferDeformation && wantsDeformation) {
    const [deformationFallbackBuild, deformationArrayBuild] = await Promise.all([
      createPipelinesBuild(session.device, session.format, lightingLayout, true, false, oneCascade, { deformation: true }),
      wantsDeformation && textureArrays ? createPipelinesBuild(session.device, session.format, lightingLayout,
        true, false, oneCascade, { deformation: true, textureArrays: true }) : undefined,
    ]);
    const deformation = deformationPipelines(deformationArrayBuild, deformationFallbackBuild)!;
    return {
      ...buildSet(fallbackBuild),
      ready: Promise.all([fallbackBuild.ready, ...(arrayBuild ? [arrayBuild.ready] : []),
        deformationFallbackBuild.ready, ...(deformationArrayBuild ? [deformationArrayBuild.ready] : [])]).then(() => undefined),
      release: () => { fallbackBuild.releaseDeferredQueues(); deformationFallbackBuild.releaseDeferredQueues(); },
      deformation,
    };
  }
  // 延迟模式：变形变体与背景 main 变体共用同一放行门（宿主在首帧验证后调用
  // release）。startDeformation 立即返回就绪 promise，首次 release 后才开始创建，
  // 并在独立校验作用域内拦截变形编译错误。
  if (deferDeformation) {
    let releaseDeferredQueues: (() => void) | undefined;
    const releaseGate = new Promise<void>(resolve => { releaseDeferredQueues = resolve; });
    let started: Promise<Pipelines> | undefined;
    return {
      ...buildSet(fallbackBuild),
      release: () => { fallbackBuild.releaseDeferredQueues(); releaseDeferredQueues?.(); },
      startDeformation: () => started ??= (async () => {
        await releaseGate;
        session.device.pushErrorScope("validation");
        try {
          const [deformationFallbackBuild, deformationArrayBuild] = await Promise.all([
            createPipelinesBuild(session.device, session.format, lightingLayout, true, false, oneCascade, { deformation: true }),
            textureArrays ? createPipelinesBuild(session.device, session.format, lightingLayout,
              true, false, oneCascade, { deformation: true, textureArrays: true }) : undefined,
          ]);
          const merged = await deformationPipelines(deformationArrayBuild, deformationFallbackBuild)!;
          const deferredError = await session.device.popErrorScope();
          if (deferredError) throw new Error(`Deferred deformation pipelines failed validation: ${deferredError.message}`);
          return merged;
        } catch (error) {
          try { await session.device.popErrorScope(); } catch { /* device loss owns diagnostics */ }
          throw error;
        }
      })(),
    };
  }
  return buildSet(fallbackBuild);
}
