import type { DeviceSession } from "./deviceSession.js";
import type { PbrRendererOptions } from "./pbrRendererTypes.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { createPipelinesBuild, type Pipelines, type PipelinesBuild } from "./pipelines.js";
import { resolvePbrMsaaSampleCount } from "./renderTargets.js";
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
  if (options.advancedMaterials !== undefined && typeof options.advancedMaterials !== "boolean")
    throw new TypeError("PBR advancedMaterials capability must be boolean.");
  if (options.advancedMaterials === true && options.features?.layeredMaterials === true)
    throw new Error("PBR advancedMaterials cannot combine with layeredMaterials.");
  const writeGeometry = features.ambientOcclusion || features.screenSpaceReflection || features.volumetricFog || features.temporalAa || features.contactShadows
    || options.deformation === true;
  const directDisplay = !features.environment && !features.fog && !features.groundGrid;
  const oneCascade = options.shadows?.exactProfile?.cascadeCount === 1;
  // AA-M1:主 pass 采样数是管线集合身份的一部分(fail-closed 解析,非法值直接抛出)。
  const mainSampleCount = resolvePbrMsaaSampleCount(options.msaaSampleCount);
  let byLayout = pipelineSets.get(session.device);
  if (!byLayout) { byLayout = new WeakMap(); pipelineSets.set(session.device, byLayout); }
  let byVariant = byLayout.get(lightingLayout);
  if (!byVariant) { byVariant = new Map(); byLayout.set(lightingLayout, byVariant); }
  const key = [PIPELINE_SET_SCHEMA, session.format, writeGeometry ? 1 : 0, directDisplay ? 1 : 0,
    oneCascade ? 1 : 0, options.deformation === true ? 1 : 0, features.textureArrays ? 1 : 0, features.layeredMaterials ? 1 : 0,
    options.advancedMaterials === true ? 1 : 0, mainSampleCount, features.rayTracedShadows ? 1 : 0,
    // B1 Brief-VSM 变体化(2026-10-05):shadowMode 进集合身份 —— 主 shader 保留虚拟
    // 采样库(sceneShaderVirtualShadows 家族)与否是模块文本/管线指纹的分野,两档不得共享。
    options.shadowMode === "virtual" ? 1 : 0, options.pipelines?.firstFrameMainKeys === undefined ? 0 : 1].join("/");
  const virtualShadowPages = options.shadowMode === "virtual";
  const existing = byVariant.get(key);
  if (existing) return existing;
  const created = buildPbrPipelineSet(session, lightingLayout, options, writeGeometry, directDisplay,
    oneCascade, features.textureArrays, features.layeredMaterials, options.advancedMaterials === true, mainSampleCount,
    features.rayTracedShadows, virtualShadowPages);
  byVariant.set(key, created);
  void created.catch(() => { if (byVariant!.get(key) === created) byVariant!.delete(key); });
  return created;
}

async function buildPbrPipelineSet(session: DeviceSession, lightingLayout: GPUBindGroupLayout,
  options: PbrRendererOptions, writeGeometry: boolean, directDisplay: boolean, oneCascade: boolean,
  textureArrays: boolean, layeredMaterials: boolean, advancedMaterials = false,
  mainSampleCount: 1 | 4 = 1, rayTracedShadowFeature = false, virtualShadowPages = false) {
  const firstFrameMainKeys = options.pipelines?.firstFrameMainKeys;
  const deformationFirstFrameMainKeys = options.pipelines?.deformationFirstFrameMainKeys ?? firstFrameMainKeys;
  const deformationSubset = deformationFirstFrameMainKeys === undefined ? {} : { firstFrameMainKeys: deformationFirstFrameMainKeys, onDemandMain: true };
  // AA-M1:mainSampleCount 必须无条件下发 —— pipelines.ts 对 undefined 的默认已从 1
  // 改为请求常量 4,省略会把 1x 回退渲染器静默升回 4x 管线(与 1x 目标失配)。
  // M2 光追阴影:RT 是管线集合身份的一部分(主 shader 变体 + group(2) 第 4 条 layout);
  // 静态与 deformation 变体同帧共存,全部下发。
  // B1 Brief-VSM 变体化:virtualShadowPages 由 shadowMode 推导(构建期一次性),
  // 静态与 deformation 变体同帧共存,全部同档下发。
  const rayTracedShadows = rayTracedShadowFeature;
  const virtualShadowOption = virtualShadowPages ? { virtualShadowPages: true } : {};
  const buildOptions = (firstFrameMainKeys === undefined && !layeredMaterials && !advancedMaterials)
    ? { mainSampleCount, ...virtualShadowOption, ...(rayTracedShadows ? { rayTracedShadows: true } : {}) }
    : { ...(firstFrameMainKeys === undefined ? {} : { firstFrameMainKeys, onDemandMain: true }),
      ...(layeredMaterials ? { layeredMaterials: true } : {}), ...(advancedMaterials ? { advancedMaterials: true } : {}),
      ...virtualShadowOption,
      ...(rayTracedShadows ? { rayTracedShadows: true } : {}),
      mainSampleCount };
  const wantsDeformation = options.deformation === true;
  const deferDeformation = wantsDeformation && options.pipelines?.deferDeformation === true;
  const buildDeformation = () => Promise.all([
    createPipelinesBuild(session.device, session.format, lightingLayout, true, false, oneCascade,
      { deformation: true, ...(layeredMaterials ? { layeredMaterials: true } : {}),
        ...(advancedMaterials ? { advancedMaterials: true } : {}), ...deformationSubset, ...virtualShadowOption,
        ...(rayTracedShadows ? { rayTracedShadows: true } : {}), mainSampleCount }),
    textureArrays ? createPipelinesBuild(session.device, session.format, lightingLayout, true, false, oneCascade,
      { deformation: true, textureArrays: true, ...deformationSubset, ...virtualShadowOption,
        ...(rayTracedShadows ? { rayTracedShadows: true } : {}), mainSampleCount }) : undefined,
  ]);
  const staticBuilds = Promise.all([
    createPipelinesBuild(session.device, session.format, lightingLayout, writeGeometry, directDisplay, oneCascade, buildOptions),
    textureArrays ? createPipelinesBuild(session.device, session.format, lightingLayout, writeGeometry,
      directDisplay, oneCascade, { ...(firstFrameMainKeys === undefined ? {} : { firstFrameMainKeys, onDemandMain: true }), textureArrays: true,
      ...(rayTracedShadows ? { rayTracedShadows: true } : {}), mainSampleCount }) : undefined,
  ]);
  // 两个 shader module 也同时开始编译；bootstrap scope 覆盖全部关键错误。
  const eagerDeformation = wantsDeformation && !deferDeformation ? buildDeformation() : undefined;
  void eagerDeformation?.catch(() => { /* 主 bootstrap 等待方处理拒绝。 */ });
  const [fallbackBuild, arrayBuild] = await staticBuilds;
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
    fallback: PipelinesBuild | undefined, critical = false): Promise<Pipelines> | undefined => {
    if (!selected && !fallback) return undefined;
    const merged = Promise.all([critical ? selected?.criticalReady : selected?.ready,
      critical ? fallback?.criticalReady : fallback?.ready].filter((value): value is Promise<void> => value !== undefined))
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
    const [deformationFallbackBuild, deformationArrayBuild] = await eagerDeformation!;
    const deformation = deformationPipelines(deformationArrayBuild, deformationFallbackBuild, deformationFirstFrameMainKeys !== undefined)!;
    return {
      ...buildSet(fallbackBuild),
      criticalReady: Promise.all([criticalReady, deformation]).then(() => undefined),
      criticalFingerprints: Object.freeze([fallbackBuild, arrayBuild, deformationFallbackBuild, deformationArrayBuild]
        .flatMap(build => build?.criticalFingerprints ?? [])),
      ready: Promise.all([fallbackBuild.ready, ...(arrayBuild ? [arrayBuild.ready] : []),
        deformationFallbackBuild.ready, ...(deformationArrayBuild ? [deformationArrayBuild.ready] : [])]).then(() => undefined),
      release: () => { fallbackBuild.releaseDeferredQueues(); arrayBuild?.releaseDeferredQueues();
        deformationFallbackBuild.releaseDeferredQueues(); deformationArrayBuild?.releaseDeferredQueues(); },
      deformation,
    };
  }
  // 延迟模式：实际变形先等关键材质子集；背景变体保留首帧后的放行门。
  // 未提供首帧键的 SDK 保留全量等待合同，独立作用域检查关键编译错误。
  if (deferDeformation) {
    let releaseDeferredQueues: (() => void) | undefined;
    const releaseGate = new Promise<void>(resolve => { releaseDeferredQueues = resolve; });
    let backgroundReleased = false;
    const deformationBuilds: PipelinesBuild[] = [];
    let started: Promise<Pipelines> | undefined;
    return {
      ...buildSet(fallbackBuild),
      release: () => { backgroundReleased = true; fallbackBuild.releaseDeferredQueues();
        arrayBuild?.releaseDeferredQueues(); releaseDeferredQueues?.();
        for (const build of deformationBuilds) build.releaseDeferredQueues(); },
      startDeformation: () => started ??= (async () => {
        if (firstFrameMainKeys === undefined) await releaseGate;
        session.device.pushErrorScope("validation");
        let validationOpen = true;
        try {
          const [deformationFallbackBuild, deformationArrayBuild] = await buildDeformation();
          deformationBuilds.push(deformationFallbackBuild, ...(deformationArrayBuild ? [deformationArrayBuild] : []));
          const merged = await deformationPipelines(deformationArrayBuild, deformationFallbackBuild, deformationFirstFrameMainKeys !== undefined)!;
          const deferredError = await session.device.popErrorScope();
          validationOpen = false;
          if (deferredError) throw new Error(`Deferred deformation pipelines failed validation: ${deferredError.message}`);
          if (backgroundReleased) for (const build of deformationBuilds) build.releaseDeferredQueues();
          return merged;
        } catch (error) {
          if (validationOpen) try { await session.device.popErrorScope(); } catch { /* device loss owns diagnostics */ }
          throw error;
        }
      })(),
    };
  }
  return buildSet(fallbackBuild);
}
