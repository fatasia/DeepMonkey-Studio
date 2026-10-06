import {
  MODEL_FORMAT_CAPABILITY_CATALOG,
  RENDERER_CAPABILITY_MANIFEST,
  rendererCapabilityEvidencePath,
  type ModelFormatCapability,
  type RendererCapabilityEndDeclaration,
  type RendererCapabilityManifestEntry,
} from "@bim-studio/contracts";

/**
 * 六引擎对标 P2「管线档×设备×能力行公开矩阵」的纯数据模型。
 *
 * 数据单源(只读消费,零手抄):
 * - 渲染管线/GI/阴影/光追/2D 等行 = contracts `RENDERER_CAPABILITY_MANIFEST`
 *   (双端 support+reason+evidence,三方对拍由 contracts 金样测试强制);
 * - 格式支持行 = contracts `MODEL_FORMAT_CAPABILITY_CATALOG`
 *   (scope/implementationStatus/runtimeStatus/validationStatus + validationEvidence);
 * - 物理域没有公开登记表——按诚实条款本模型只给"未登记"空态,不虚构行。
 *
 * 本文件只做"登记状态 → 公开状态文案/色调"的派生映射与分域归类;
 * 状态词汇映射表与登记表 reasonPairsForSupport 一一对应,新增原因码时此处显式落兜底。
 */

export type CapabilityTone = "ok" | "optin" | "neutral" | "warn" | "planned" | "blocked";

/** 单端公开状态单元格(label/tone 由 support+reason 派生;证据原样透传)。 */
export interface CapabilityMatrixEndCell {
  readonly support: RendererCapabilityManifestEntry["web"]["support"];
  readonly reason: RendererCapabilityManifestEntry["web"]["reason"];
  readonly label: string;
  readonly tone: CapabilityTone;
  /** 完整证据串(路径:符号(说明)),展示于 title。 */
  readonly evidence: string;
  /** 可用于展示的仓库相对路径(rendererCapabilityEvidencePath 派生)。 */
  readonly evidencePath: string;
}

export interface CapabilityMatrixRow {
  readonly id: string;
  readonly title: string;
  readonly web: CapabilityMatrixEndCell;
  readonly native: CapabilityMatrixEndCell;
}

export interface CapabilityMatrixDomain {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly CapabilityMatrixRow[];
}

export interface CapabilityMatrixCounts {
  readonly total: number;
  /** 双端都 supported 的行数。 */
  readonly bothSupported: number;
  /** 任一端 degraded(且无 unavailable)的行数。 */
  readonly limited: number;
  /** 任一端 unavailable 的行数(公开语义=规划中/平台未提供)。 */
  readonly planned: number;
}

export interface FormatMatrixRow {
  readonly id: string;
  readonly label: string;
  readonly extensions: readonly string[];
  readonly directionLabel: string;
  readonly scopeLabel: string;
  readonly statusLabel: string;
  readonly tone: CapabilityTone;
  readonly decisionReason: string;
  /** validationEvidence 引用串(可追溯报告/制品/测试);空数组=行内展示"暂无证据记录"。 */
  readonly evidenceRefs: readonly string[];
}

export interface EngineCapabilityMatrix {
  readonly renderer: {
    readonly domains: readonly CapabilityMatrixDomain[];
    readonly counts: CapabilityMatrixCounts;
  };
  readonly formats: {
    readonly rows: readonly FormatMatrixRow[];
    readonly productionReady: number;
  };
}

/** 支持档+原因码 → 公开状态文案与色调(9 种合法配对全覆盖,未知配对落中性兜底)。 */
export function capabilityStatusCell(end: RendererCapabilityEndDeclaration): CapabilityMatrixEndCell {
  const [label, tone] = STATUS_LABELS[end.support]?.[end.reason] ?? [SUPPORT_FALLBACK[end.support], "neutral" as const];
  return {
    support: end.support,
    reason: end.reason,
    label,
    tone,
    evidence: end.evidence,
    evidencePath: rendererCapabilityEvidencePath(end.evidence),
  };
}

const SUPPORT_FALLBACK: Record<RendererCapabilityEndDeclaration["support"], string> = {
  supported: "完整",
  degraded: "降级",
  unavailable: "不可用",
};

const STATUS_LABELS: Partial<Record<RendererCapabilityEndDeclaration["support"],
  Partial<Record<RendererCapabilityEndDeclaration["reason"], readonly [string, CapabilityTone]>>> > = {
  supported: {
    "full": ["完整可用", "ok"],
    "opt-in-default-off": ["可用 · 需开启", "optin"],
    "harness-only": ["验收通路", "neutral"],
  },
  degraded: {
    "reduced-tier": ["降级", "warn"],
    "opt-in-default-off": ["降级 · 需开启", "warn"],
    "harness-only": ["降级 · 验收通路", "warn"],
  },
  unavailable: {
    "absent": ["规划中", "planned"],
    "api-missing": ["依赖平台 API", "blocked"],
    "host-specific": ["宿主专属", "neutral"],
  },
};

/** 域归类:前缀规则优先,显式集合兜位,其余落"其他能力"——新登记 id 永不丢行。 */
export function rendererCapabilityDomainId(id: string): string {
  if (id.startsWith("deep2d-")) return "deep-2d";
  if (id.startsWith("ray-traced-") || id === "hardware-ray-query") return "ray-tracing";
  if (id === "sdf-gi" || id === "ssgi" || id.startsWith("gi-") || id === "ibl-environment" || id === "megalights") return "gi";
  if (id.startsWith("shadow-") || id === "contact-shadows" || id === "local-shadow-abi-16") return "shadows";
  if (id === "projected-textures") return "post-fx";
  if (id.startsWith("material-") || id === "white-furnace-conservation" || id === "ies-lighting") return "materials";
  if (id.startsWith("device-recovery")) return "device";
  if (POSTFX_IDS.has(id)) return "post-fx";
  if (LARGE_SCENE_IDS.has(id)) return "large-scene";
  return "other";
}

const DOMAIN_TITLES: Readonly<Record<string, string>> = {
  "gi": "全局光照(GI)",
  "shadows": "阴影",
  "ray-tracing": "光线追踪",
  "deep-2d": "Deep 2D",
  "post-fx": "后处理与显示",
  "large-scene": "大场景与渲染管线",
  "materials": "材质与着色",
  "device": "设备与恢复",
  "other": "其他能力",
};

const POSTFX_IDS: ReadonlySet<string> = new Set([
  "taa", "temporal-upscale", "spatial-aa", "bloom", "tonemap-display", "auto-exposure",
  "fog-volumetric", "ssr", "ambient-occlusion", "author-grading-vignette", "hdr-display-output",
  "debug-full-render", "weighted-oit", "object-outline", "ground-preview", "atmosphere-sky",
]);

const LARGE_SCENE_IDS: ReadonlySet<string> = new Set([
  "visibility-buffer", "occlusion-culling", "gpu-lod", "cluster-lod",
  "virtual-textures", "texture-arrays", "virtual-geometry",
]);

/** 域展示顺序(GI→阴影→光追→2D→后处理→大场景→材质→设备→其他)。 */
const DOMAIN_ORDER = ["gi", "shadows", "ray-tracing", "deep-2d", "post-fx", "large-scene", "materials", "device", "other"] as const;

function toRow(entry: RendererCapabilityManifestEntry): CapabilityMatrixRow {
  return {
    id: entry.id,
    title: entry.title,
    web: capabilityStatusCell(entry.web),
    native: capabilityStatusCell(entry.native),
  };
}

/** 登记表 → 分域能力行(登记序保持,域按 DOMAIN_ORDER 排;空清单返回空域数组)。 */
export function buildRendererCapabilityDomains(
  manifest: readonly RendererCapabilityManifestEntry[] = RENDERER_CAPABILITY_MANIFEST,
): readonly CapabilityMatrixDomain[] {
  const byDomain = new Map<string, CapabilityMatrixRow[]>();
  for (const entry of manifest) {
    const domainId = rendererCapabilityDomainId(entry.id);
    const rows = byDomain.get(domainId) ?? [];
    rows.push(toRow(entry));
    byDomain.set(domainId, rows);
  }
  return DOMAIN_ORDER
    .filter(domainId => (byDomain.get(domainId)?.length ?? 0) > 0)
    .map(domainId => ({ id: domainId, title: DOMAIN_TITLES[domainId] ?? domainId, rows: byDomain.get(domainId)! }));
}

export function rendererCapabilityCounts(
  manifest: readonly RendererCapabilityManifestEntry[] = RENDERER_CAPABILITY_MANIFEST,
): CapabilityMatrixCounts {
  let bothSupported = 0;
  let anyUnavailable = 0;
  for (const entry of manifest) {
    const supports = [entry.web.support, entry.native.support];
    if (supports.every(support => support === "supported")) bothSupported += 1;
    if (supports.some(support => support === "unavailable")) anyUnavailable += 1;
  }
  const total = manifest.length;
  return {
    total,
    bothSupported,
    limited: Math.max(0, total - bothSupported - anyUnavailable),
    planned: anyUnavailable,
  };
}

const DIRECTION_LABELS: Readonly<Record<ModelFormatCapability["direction"], string>> = {
  "import": "导入",
  "export": "导出",
  "both": "导入/导出",
};

const SCOPE_LABELS: Readonly<Record<ModelFormatCapability["scope"], string>> = {
  "core": "内置",
  "optional": "可选",
  "excluded": "不支持范围",
};

/** 格式目录 → 公开状态行(状态词汇与 modelFormatCapability 合同同源)。 */
export function buildFormatCapabilityRows(
  catalog: readonly ModelFormatCapability[] = MODEL_FORMAT_CAPABILITY_CATALOG,
): readonly FormatMatrixRow[] {
  return catalog.map(capability => {
    const [statusLabel, tone] = formatStatus(capability);
    return {
      id: capability.id,
      label: capability.label,
      extensions: capability.extensions,
      directionLabel: DIRECTION_LABELS[capability.direction],
      scopeLabel: SCOPE_LABELS[capability.scope],
      statusLabel,
      tone,
      decisionReason: capability.decisionReason,
      evidenceRefs: capability.validationEvidence.map(evidence => evidence.reference),
    };
  });
}

function formatStatus(capability: ModelFormatCapability): readonly [string, CapabilityTone] {
  if (capability.scope === "excluded" || capability.implementationStatus === "excluded") return ["不支持", "blocked"] as const;
  if (capability.implementationStatus === "planned") return ["规划中", "planned"] as const;
  if (capability.implementationStatus === "in-development") return ["开发中", "warn"] as const;
  switch (capability.validationStatus) {
    case "production-validated": return ["生产可用", "ok"] as const;
    case "fixture-validated": return ["可用(样例验证)", "optin"] as const;
    case "failed": return ["验证未通过", "blocked"] as const;
    case "not-applicable": return ["已实现", "neutral"] as const;
    case "unverified":
    default: return ["已实现 · 待验证", "neutral"] as const;
  }
}

export function formatProductionReadyCount(
  catalog: readonly ModelFormatCapability[] = MODEL_FORMAT_CAPABILITY_CATALOG,
): number {
  return catalog.filter(capability =>
    capability.implementationStatus === "implemented" && capability.validationStatus === "production-validated").length;
}

/** 页面单源入口:一次构建渲染域 + 格式行 + 计数(运行时读,不手抄一行状态)。 */
export function buildEngineCapabilityMatrix(): EngineCapabilityMatrix {
  return {
    renderer: {
      domains: buildRendererCapabilityDomains(),
      counts: rendererCapabilityCounts(),
    },
    formats: {
      rows: buildFormatCapabilityRows(),
      productionReady: formatProductionReadyCount(),
    },
  };
}
