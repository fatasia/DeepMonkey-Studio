import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { ProbeGridBakeService, type ProbeGridBakeGrid, type ProbeRadianceLighting } from "@bim-studio/deep-engine";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";
import { compileSceneLighting } from "./compileSceneLighting";
import { compileSceneRenderPacket } from "./compileSceneRenderPacket";
import { probeGridBakeSourceHash, storeProbeGridBake, type ProbeGridBakeSessionEntry } from "./probeGridBakePublicationSession";

/**
 * F3 探针网格烘焙的浏览器端执行编排：把"场景快照 → RenderPacket → GPU 烘焙 →
 * 发布会话态"串成一次可从 UI 调用的动作。
 *
 * == 与既有合同的分工 ==
 * - RenderPacket 构建：复用 `compileSceneRenderPacket`（纯 CPU 编译，不访问编辑器
 *   当前 GPU 状态），因此烘焙不依赖 viewport 的渲染后端；
 * - GPU 编排：复用 deep-engine `ProbeGridBakeService`（捕获→读回→聚合→编译器输入
 *   对账全部在服务内 fail-closed），本模块只供给 device、场景与光照；
 * - 光照映射：`probeRadianceLightingForBake` 把编译器灯光输出映射为烘焙辐射源——
 *   `RuntimeAuthoredLighting.direction` 在 Native 端被 shadow_ray_direction 直接
 *   当作 surface_to_light 消费（gpu_resources.rs:97），与 producer 的
 *   `surfaceToLightWorld` 同名同义，因此原样传递、不取反。
 *
 * == 诚实边界 ==
 * - 环境项 ambient 宿主馈 [0,0,0]（EnvironmentAmbientReader 的真实 GPU 读回属后续
 *   切片）：纯环境漫射、无方向光的场景会被服务既有 fail-closed 合同拒绝，UI 如实
 *   报错，不虚构烘焙结果；
 * - 烘焙请求独立 requestDevice（烘焙结束即 destroy），不与 viewport 共享 device；
 * - 烘焙进度是阶段型（compile-scene / request-gpu / capture / store），GPU 内部
 *   无细粒度进度回调。
 */

export type ProbeGridBakePhase = "compile-scene" | "request-gpu" | "capture" | "store";

/** 一次成功烘焙的完整回执：会话态条目 + 发布透传所需的身份。 */
export interface ProbeGridBakeRunOutcome extends ProbeGridBakeSessionEntry {
  /** 发布会话态键（编译器严格源投影哈希）；与 lookup 的键同源。 */
  readonly sourceHash: string;
  /** 覆盖率 = coveredCount / probeCount（0..1）。 */
  readonly coverage: number;
}

export interface ProbeGridBakeRunOptions {
  readonly scene: SceneSnapshot;
  /** 项目模型清单（loadModel 从这里解析 GLB 资源地址）。 */
  readonly models: ProjectRecord["models"];
  readonly grid: ProbeGridBakeGrid;
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: ProbeGridBakePhase) => void;
}

/** 烘焙服务构造参数里的 device 类型（从服务构造签名反推，不在 web 侧直接引用 GPUDevice 名）。 */
type ProbeGridBakeDevice = ConstructorParameters<typeof ProbeGridBakeService>[0];

/**
 * 场景灯光 → 烘焙辐射源。编译失败（灯光不合法/非晴天天气）fail-closed 抛错；
 * 直射光能量为 0 时提前报错（与 producer 零能量拒绝合同一致，省一次 GPU 往返）。
 * 纯函数：可脱离 GPU 直接单测。
 */
export function probeRadianceLightingForBake(lighting: SceneSnapshot["lighting"], weather: SceneSnapshot["weather"]): ProbeRadianceLighting {
  const compiled = compileSceneLighting(lighting, weather);
  if (!compiled) {
    throw new Error("场景灯光无法编译为烘焙辐射源：需要至少一盏启用的方向光，且天气为晴天");
  }
  const radiance = compiled.radiance;
  if (!(radiance[0] + radiance[1] + radiance[2] > 0)) {
    throw new Error("场景没有可用的直射光辐射源：请启用方向光并调高强度后再烘焙");
  }
  // direction 在 Native 端即 surface_to_light（gpu_resources.rs shadow_ray_direction），
  // 与烘焙服务的 surfaceToLightWorld 同义，原样传递；radiance 已预乘全局×单灯强度，
  // 因此 intensity 恒为 1。ambient 宿主馈零：本切片无环境读回接入。
  return {
    primary: { surfaceToLightWorld: compiled.direction, color: radiance, intensity: 1 },
    ambient: [0, 0, 0],
  };
}

/** 项目模型 → GLB 字节的加载器（与 sceneClientPackage 的 native 编译加载器同构）。 */
export function buildSceneModelLoader(models: ProjectRecord["models"]):
  (assetId: string, loadSignal: AbortSignal) => Promise<Uint8Array> {
  return async (assetId, loadSignal) => {
    loadSignal.throwIfAborted();
    const model = models.find(item => item.id === assetId);
    const geometryUrl = model?.manifest?.geometryUrl;
    if (!geometryUrl) throw new Error(`烘焙缺少模型资源：${assetId}`);
    return new Uint8Array(await loadViewerAssetBuffer(geometryUrl, model.name, { signal: loadSignal }));
  };
}

/** 请求烘焙专用 device；浏览器不支持/取不到适配器时给出可操作的中文错误。 */
async function requestBakeDevice(signal: AbortSignal | undefined): Promise<ProbeGridBakeDevice> {
  signal?.throwIfAborted();
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown> };
  }).gpu;
  if (!gpu) throw new Error("当前浏览器不支持 WebGPU，无法烘焙探针网格；请使用支持 WebGPU 的浏览器");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" }) as
    { requestDevice(): ProbeGridBakeDevice } | null;
  if (!adapter) throw new Error("未获取到 WebGPU 适配器，无法烘焙探针网格");
  return adapter.requestDevice();
}

/**
 * 一次端到端烘焙：编译场景 → 请求 GPU → 服务烘焙 → 存发布会话态。
 * 任一阶段失败即抛错（服务内部 fail-closed 合同保持不变），不产出会话条目。
 */
export async function runProbeGridBake(options: ProbeGridBakeRunOptions): Promise<ProbeGridBakeRunOutcome> {
  const { scene, models, grid, signal, onPhase } = options;
  signal?.throwIfAborted();
  // 光照映射先行（纯 CPU）：辐射源不合法在这里 fail-fast，不浪费编译与 GPU。
  const lighting = probeRadianceLightingForBake(scene.lighting, scene.weather);
  onPhase?.("compile-scene");
  const compilation = await compileSceneRenderPacket(scene, {
    loadModel: buildSceneModelLoader(models), ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  onPhase?.("request-gpu");
  const device = await requestBakeDevice(signal);
  try {
    onPhase?.("capture");
    const service = new ProbeGridBakeService(device, { lighting });
    let evidence;
    try {
      evidence = await service.bake(compilation.packet, grid);
    } finally {
      service.dispose();
    }
    signal?.throwIfAborted();
    const entry: ProbeGridBakeSessionEntry = { bake: evidence.bake,
      probeCount: evidence.probeCount, coveredCount: evidence.coveredCount,
      bakedAt: new Date().toISOString() };
    onPhase?.("store");
    storeProbeGridBake(scene, entry);
    return { ...entry, sourceHash: probeGridBakeSourceHash(scene),
      coverage: evidence.probeCount > 0 ? evidence.coveredCount / evidence.probeCount : 0 };
  } finally {
    device.destroy();
  }
}
