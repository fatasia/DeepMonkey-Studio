import type { AppLocale } from "../i18n";

/**
 * 实验性功能注册表:集中枚举全部 opt-in / opt-out URL 开关,供
 * ExperimentalFeaturesPanel 展示与链接生成。
 *
 * 唯一事实来源仍是 `studioDeepWebGpuBridgeFeatureToggles.ts`(桥创建时读
 * `location.search`);本注册表只做"发现性"呈递,不改变任何读取语义。
 * `isExperimentalFeatureEnabled` 与既有 toggle 函数的真值判定逐字对齐
 * (opt-in: 1/true/on;opt-out: 0/false/off 之外全开),并由
 * experimentalFeatures.test.ts 做逐参数对拍,防止单侧漂移。
 */

export interface ExperimentalFeatureSpec {
  /** URL 参数名,与 studioDeepWebGpuBridgeFeatureToggles.ts 中的参数逐字一致。 */
  readonly param: string;
  /** opt-in = 默认关、显式开启;opt-out = 默认开、显式关闭。 */
  readonly kind: "opt-in" | "opt-out";
  /** 双语名称 [zh, en]。 */
  readonly label: readonly [string, string];
  /** 双语说明 [zh, en]:开了之后发生什么、为什么默认关。 */
  readonly detail: readonly [string, string];
  /** 依赖开关:该参数单独开启无效(引擎侧门),面板需要提示。 */
  readonly requires?: {
    readonly param: string;
    readonly note: readonly [string, string];
  };
  /** 分组:渲染路径 / 调试工具,面板按组呈现。 */
  readonly group: "rendering" | "debug";
}

export const EXPERIMENTAL_FEATURES: readonly ExperimentalFeatureSpec[] = [
  {
    param: "t07-dynamic-resolution",
    kind: "opt-in",
    label: ["动态内部分辨率", "Dynamic internal resolution"],
    detail: [
      "按帧时反馈在 0.5–1 之间调整内部渲染比例,牺牲清晰度换帧率;默认画质未经联测,默认关闭。",
      "Adjusts the internal render scale between 0.5 and 1 based on frame-time feedback; off by default pending quality validation.",
    ],
    group: "rendering",
  },
  {
    param: "f4-temporal-upscale",
    kind: "opt-in",
    label: ["时域超分", "Temporal upscale"],
    detail: [
      "在内部分辨率低于 1 时激活时域复用超分,恢复感知清晰度。",
      "Activates temporal reuse upscaling when the internal render scale is below 1.",
    ],
    requires: {
      param: "t07-dynamic-resolution",
      note: [
        "需与「动态内部分辨率」同开,单开无效。",
        "Requires dynamic internal resolution; enabling it alone has no effect.",
      ],
    },
    group: "rendering",
  },
  {
    param: "f3-virtual-textures",
    kind: "opt-in",
    label: ["虚拟纹理", "Virtual textures"],
    detail: [
      "大纹理按需驻留,降低显存占用;关闭时保持整纹理驻留路径逐位不变。",
      "Streams large textures on demand to reduce VRAM; off keeps the whole-texture residency path unchanged.",
    ],
    group: "rendering",
  },
  {
    param: "b4-hlod-cluster",
    kind: "opt-in",
    label: ["簇级 HLOD 驻留感知隐藏", "Cluster HLOD residency culling"],
    detail: [
      "按相机消费簇决策做 demand 过滤与代理 overlay 注入;选择/剖切/测量强制原件驻留。",
      "Filters clusters by camera decisions with proxy overlay injection; selection/section/measure pin originals resident.",
    ],
    group: "rendering",
  },
  {
    param: "g1-cluster-lod",
    kind: "opt-in",
    label: ["簇级微多边形槽位", "Cluster micro-polygon slot"],
    detail: [
      "把作者包合并静态几何 bake 成簇级 DAG 注入渲染器槽位,像素阈值选层;注入失败仅记诊断。",
      "Bakes merged static geometry into a cluster DAG injected into the renderer slot with pixel-threshold selection; failures are diagnostic only.",
    ],
    group: "rendering",
  },
  {
    param: "mega-lights",
    kind: "opt-in",
    label: ["MegaLights 万灯", "MegaLights many-lights"],
    detail: [
      ">64 本地灯走 RIS 采样路径(≤64 簇光路径逐位零变化);超上限引擎侧拒绝。",
      "Routes >64 local lights through RIS sampling (≤64 cluster lights unchanged bit-exact); over-limit is rejected by the engine.",
    ],
    group: "rendering",
  },
  {
    param: "ray-traced-shadows",
    kind: "opt-in",
    label: ["方向光 RT 阴影", "Ray-traced directional shadows"],
    detail: [
      "构建 RT 资源与管线变体;TLAS 宿主链未接时 features 快照自动清 0 回级联,不静默假开。",
      "Builds RT resources and pipeline variants; falls back to cascades when the TLAS host chain is not wired.",
    ],
    group: "rendering",
  },
  {
    param: "sdf-gi",
    kind: "opt-in",
    label: ["GI 光照烘焙", "SDF GI bake"],
    detail: [
      "按场景 revision 自动烘焙 GPU 距离场 + 天光追踪 + 探针 SH;「光照烘焙」工作台可观测产物。",
      "Auto-bakes GPU distance fields with sky tracing and probe SH on scene revision changes; observable in the lighting-bake workbench.",
    ],
    group: "rendering",
  },
  {
    param: "ssgi",
    kind: "opt-in",
    label: ["SSGI 屏空间漫射", "SSGI screen-space diffuse"],
    detail: [
      "P2 六引擎对标:半分辨率余弦半球一次反弹 + 加性合成(输出在 SSR/TAA 前,TAA 顺带时域平滑);与 GI 光照烘焙叠加合法(探针管 ambient,SSGI 管反弹)。",
      "Six-engine parity P2: half-res cosine-hemisphere one-bounce with additive composite (before SSR/TAA; TAA stabilizes); stacks safely with SDF GI (probes own ambient, SSGI owns bounce).",
    ],
    group: "rendering",
  },
  {
    param: "t25-gpu-pass-timing",
    kind: "opt-in",
    label: ["逐 Pass GPU 计时", "Per-pass GPU timing"],
    detail: [
      "timestamp 查询有逐帧开销;开启后质量遥测面板出现「逐 Pass GPU 耗时」小节。",
      "Timestamp queries cost per frame; the quality telemetry panel gains a per-pass GPU timing section.",
    ],
    group: "debug",
  },
  {
    param: "debug-full-render",
    kind: "opt-in",
    label: ["全量渲染对照", "Debug full render"],
    detail: [
      "时域 pass 照常运行但历史每帧强制失效,用于二分伪影来自时域复用还是上游 pass。",
      "Forces temporal history invalidation each frame to bisect whether artifacts come from temporal reuse or upstream passes.",
    ],
    group: "debug",
  },
  {
    param: "t11-critical-pipelines",
    kind: "opt-out",
    label: ["首帧关键管线子集", "First-frame critical pipeline subset"],
    detail: [
      "发布前只等待首帧关键管线子集,加快首帧;关闭后回退为等待全部管线。",
      "Publish waits only for the critical first-frame pipeline subset; disabling waits for all pipelines.",
    ],
    group: "debug",
  },
  {
    param: "t11-defer-deformation",
    kind: "opt-out",
    label: ["变形变体延迟创建", "Defer deformation variants"],
    detail: [
      "变形管线变体延迟到需要时创建;关闭后回退为发布前全量创建。",
      "Defers deformation pipeline variants until needed; disabling creates them all before publish.",
    ],
    group: "debug",
  },
] as const;

/** 读取单个开关的当前生效态(与桥侧 toggle 函数判定逐字一致)。 */
export function isExperimentalFeatureEnabled(spec: ExperimentalFeatureSpec, search: string): boolean {
  const value = new URLSearchParams(search).get(spec.param)?.toLowerCase();
  if (spec.kind === "opt-out") return value !== "0" && value !== "false" && value !== "off";
  return value === "1" || value === "true" || value === "on";
}

/** 一次读取全部开关态,key = param。 */
export function readExperimentalFeatureStates(search: string): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const spec of EXPERIMENTAL_FEATURES) states[spec.param] = isExperimentalFeatureEnabled(spec, search);
  return states;
}

/**
 * 由草稿态生成带参链接。编码与桥侧判定严格互逆:
 * opt-in 开 → `=1`;opt-in 关 → 移除;opt-out 开(默认)→ 移除;opt-out 关 → `=0`
 * (桥侧只认 0/false/off 为关,写其他值等于开)。链接只含非默认项,可读可分享,
 * 并保留路由、场景、项目等其余参数原样。
 */
export function buildExperimentalFeatureHref(href: string, states: Record<string, boolean>): string {
  const url = new URL(href);
  for (const spec of EXPERIMENTAL_FEATURES) {
    const enabled = states[spec.param] ?? spec.kind === "opt-out";
    if (spec.kind === "opt-in") {
      if (enabled) url.searchParams.set(spec.param, "1");
      else url.searchParams.delete(spec.param);
    } else if (!enabled) url.searchParams.set(spec.param, "0");
    else url.searchParams.delete(spec.param);
  }
  return url.href;
}

export function experimentalFeatureLabel(spec: ExperimentalFeatureSpec, locale: AppLocale): string {
  return locale === "zh-CN" ? spec.label[0] : spec.label[1];
}

export function experimentalFeatureDetail(spec: ExperimentalFeatureSpec, locale: AppLocale): string {
  return locale === "zh-CN" ? spec.detail[0] : spec.detail[1];
}
