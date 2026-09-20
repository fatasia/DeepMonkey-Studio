import * as THREE from "three";
import type {
  SceneEngineeringAnalysisState,
  SceneQtoCategoryMapping,
} from "@bim-studio/contracts";

// P5/P7 工程分析状态（2026-09-20 切片）：
// - 净空/限高规则与 QTO 分类口径映射随场景文档保存，重开恢复；
// - normalize 逐字段重建：未知字段一律不采纳（拒绝），非法取值回落到
//   文档化默认或整条丢弃，不做猜测式修补；
// - 映射应用是纯函数：数组顺序、首条命中生效，未命中回落内置类别推断。

export const DEFAULT_ENGINEERING_ANALYSIS: SceneEngineeringAnalysisState = {
  minimumClearance: 0.5,
  heightLimit: 4,
  qtoMappings: [],
};

const MAPPING_SOURCES = ["material-name", "object-name", "custom-property"] as const;
const MAX_MAPPINGS = 256;
const MAX_TEXT = 256;

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeMapping(raw: unknown, index: number): SceneQtoCategoryMapping | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<SceneQtoCategoryMapping>;
  // source 白名单之外的取值整条拒绝（不猜测为最接近的来源）。
  const source = MAPPING_SOURCES.find((item) => item === candidate.source);
  if (!source) return undefined;
  const id = boundedText(candidate.id, MAX_TEXT) || `qto-mapping-${index + 1}`;
  const pattern = boundedText(candidate.pattern, MAX_TEXT);
  const propertyKey = boundedText(candidate.propertyKey, MAX_TEXT);
  const category = boundedText(candidate.category, 128);
  if (!category) return undefined;
  // 材质名/对象名匹配必须有非空 pattern；自定义属性必须有属性键。
  if (source !== "custom-property" && !pattern) return undefined;
  if (source === "custom-property" && !propertyKey) return undefined;
  const mapping: SceneQtoCategoryMapping = { id, enabled: candidate.enabled !== false, source, pattern, category };
  if (source === "custom-property") mapping.propertyKey = propertyKey;
  return mapping;
}

/** 未知字段不采纳、非法条目丢弃的确定性恢复入口；永远返回完整可用状态。 */
export function normalizeSceneEngineeringAnalysis(value: unknown): SceneEngineeringAnalysisState {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_ENGINEERING_ANALYSIS);
  const candidate = value as Partial<SceneEngineeringAnalysisState>;
  const minimumClearance = typeof candidate.minimumClearance === "number" && Number.isFinite(candidate.minimumClearance) && candidate.minimumClearance >= 0
    ? candidate.minimumClearance
    : DEFAULT_ENGINEERING_ANALYSIS.minimumClearance;
  const heightLimit = typeof candidate.heightLimit === "number" && Number.isFinite(candidate.heightLimit) && candidate.heightLimit > 0
    ? candidate.heightLimit
    : DEFAULT_ENGINEERING_ANALYSIS.heightLimit;
  const rawMappings = Array.isArray(candidate.qtoMappings) ? candidate.qtoMappings.slice(0, MAX_MAPPINGS) : [];
  const qtoMappings = rawMappings
    .map((raw, index) => normalizeMapping(raw, index))
    .filter((mapping): mapping is SceneQtoCategoryMapping => Boolean(mapping));
  return { minimumClearance, heightLimit, qtoMappings };
}

export interface QtoMappingTarget {
  /** 模型/基础元素的显示名（对象名匹配来源）。 */
  name: string;
  kind: "model" | "primitive";
  object: THREE.Object3D;
}

/** 收集对象树的材质名（含材质数组），用于材质名口径匹配。 */
function collectMaterialNames(root: THREE.Object3D): string[] {
  const names: string[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const item of Array.isArray(material) ? material : [material]) {
      if (item.name) names.push(item.name);
    }
  });
  return names;
}

function contains(text: string, pattern: string): boolean {
  return text.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * 按保存的口径映射解析 QTO 类别：数组顺序、首条 enabled 命中生效。
 * 返回 undefined 表示无命中，调用方回落到内置类别推断。
 */
export function applyQtoCategoryMapping(target: QtoMappingTarget, mappings: readonly SceneQtoCategoryMapping[]): string | undefined {
  let materialNames: string[] | undefined;
  for (const mapping of mappings) {
    if (!mapping.enabled) continue;
    // 编辑器允许暂存未完成条目；应用层对不完整规则直接跳过（fail-closed，
    // 不把空 pattern 当作“匹配一切”）。
    if (!mapping.category) continue;
    if (mapping.source !== "custom-property" && !mapping.pattern) continue;
    if (mapping.source === "custom-property" && !mapping.propertyKey) continue;
    const hit = (() => {
      if (mapping.source === "object-name") return contains(target.name, mapping.pattern);
      if (mapping.source === "material-name") {
        materialNames ??= collectMaterialNames(target.object);
        return materialNames.some((name) => contains(name, mapping.pattern));
      }
      // custom-property：属性键存在即命中；pattern 非空时再要求值（字符串化）包含 pattern。
      const value = target.object.userData[mapping.propertyKey ?? ""];
      if (value === undefined || value === null) return false;
      return !mapping.pattern || contains(String(value), mapping.pattern);
    })();
    if (hit) return mapping.category;
  }
  return undefined;
}
