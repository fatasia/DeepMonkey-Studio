import { DEFAULT_RESOLUTION_SCALE_POLICY } from "@bim-studio/deep-engine/postprocess";

export function markSwitchPhase(name: string): void {
  if (typeof performance?.mark === "function") performance.mark(name);
}

/**
 * T11 首帧管线时序开关：独立作者包路径生产默认启用两个可独立回退的时序优化——
 * 首帧关键管线子集（`t11-critical-pipelines=0` 关闭）与变形变体延迟创建
 * （`t11-defer-deformation=0` 关闭）。两开关只改变"发布前等待哪些变体"，
 * 不改变任何帧的画质与管线集合内容。
 */
export function t11PipelineBootstrap(hasAuthorPacket: boolean):
  { firstFrameSubset: boolean; deferDeformation: boolean } | undefined {
  if (!hasAuthorPacket) return undefined;
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const enabled = (name: string): boolean => {
    const value = params?.get(name)?.toLowerCase();
    return value !== "0" && value !== "false" && value !== "off";
  };
  return { firstFrameSubset: enabled("t11-critical-pipelines"), deferDeformation: enabled("t11-defer-deformation") };
}

/**
 * T07 动态内部分辨率接入开关：默认关闭（67% 模式画质未经 GPU 序列联测，不冒充
 * 默认优秀画质）；`t07-dynamic-resolution=1` 显式开启后按帧时反馈在 0.5–1 之间
 * 调整内部渲染比例。开启即消费 deep-engine `resolutionScalePolicy` 能力。
 */
export function t07DynamicResolutionPolicy():
  import("@bim-studio/deep-engine/postprocess").ResolutionScalePolicy | undefined {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("t07-dynamic-resolution")?.toLowerCase();
  if (value !== "1" && value !== "true" && value !== "on") return undefined;
  return { ...DEFAULT_RESOLUTION_SCALE_POLICY };
}

/**
 * B4 簇级 HLOD 驻留感知隐藏开关：默认关闭（簇代理画质与切换序列未过浏览器视觉
 * 闭环，不冒充默认体验）；`b4-hlod-cluster=1` 显式开启后，Deep 后端按相机消费
 * 簇决策做 demand 过滤 + 行置零补偿 + 代理 overlay 注入，选择/剖切/测量
 * （编辑辅助 overlay 顶点非空）强制原件驻留。
 */
export function b4HlodClusterEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("b4-hlod-cluster")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * G1 簇级微多边形槽位开关：默认关闭（作者链路帧时收益未过真机对照，不冒充默认
 * 体验）；`g1-cluster-lod=1` 显式开启后，宿主把作者包合并静态几何 bake 成簇级
 * DAG 随 create 下发，backend 在静态包发布成功后注入渲染器槽位（像素阈值选层 +
 * indirect RenderBundle 进默认 opaque pass）。注入失败仅记诊断，不打断渲染链。
 */
export function g1ClusterLodEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("g1-cluster-lod")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * T25 逐 pass GPU 计时采集开关（F1）：默认关闭（timestamp 查询有逐帧开销）；
 * `t25-gpu-pass-timing=1` 开启后 T25 面板出现「逐 Pass GPU 耗时」小节。
 */
export function t25GpuPassTimingEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("t25-gpu-pass-timing")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * F4 时域超分采集开关：`f4-temporal-upscale=1`。需与 `t07-dynamic-resolution=1`
 * 同开——超分在 scale<1 时才激活（temporalUpscaleActive 门），单开无效。
 */
export function f4TemporalUpscaleEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("f4-temporal-upscale")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * 全量渲染对照开关：`debug-full-render=1`（排查工具，默认关闭）。
 * 开启后时域 pass（TAA/TSR）结构照常运行但历史每帧强制失效，输出退化为纯当前帧——
 * 用于二分"伪影来自时域复用还是上游 pass"（对标 gpui-fast GPUI_VIEW_RETENTION=0）。
 */
export function debugFullRenderEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("debug-full-render")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * MegaLights 万灯 RIS 开关：`mega-lights=1`（opt-in，默认关）。
 * 开启后 >64 本地灯走 MegaLights RIS 路径（≤64 簇光路径逐位零变化）；
 * 灯数超 MAX_MEGA_LIGHTS 引擎侧 fail-closed 拒绝。
 */
export function megaLightsEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("mega-lights")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * 方向光 RT 阴影开关：`ray-traced-shadows=1`（opt-in，默认关）。
 * 开启后渲染器构建 RT 资源与管线变体；**场景几何供给（TLAS）宿主链未接时
 * features 快照 RT 位自动清 0 回级联（引擎 fail-closed，不静默假开）**。
 */
export function rayTracedShadowsEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("ray-traced-shadows")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/** F3 虚拟纹理开关：`f3-virtual-textures=1`（opt-in，默认整纹理驻留路径零变化）。 */
export function f3VirtualTexturesEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("f3-virtual-textures")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/**
 * GI 光照烘焙开关（Brief-GI M2/M3）：`sdf-gi=1`。默认关闭（能力登记为
 * supported/opt-in-default-off；关闭 = 引擎不构建 SDF GI 运行时，帧逐位零变化）。
 * 开启后 Deep 后端按包场景 revision 变化自动烘焙（GPU 距离场 + 天光追踪 + 探针
 * SH 更新 + 探针场物化），「光照烘焙」工作台面板随之可观测烘焙计数与产物规模。
 */
export function sdfGiEnabled(): boolean {
  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : undefined;
  const value = params?.get("sdf-gi")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}
