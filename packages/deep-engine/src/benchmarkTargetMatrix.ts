import { CAPABILITY_DOMAIN_WEIGHTS, type BenchmarkReference } from "./benchmarkContract";

/** A01 · 四引擎目标矩阵 v2:版本/渲染器/平台/任务/必选能力/禁止退化项,
 *  公共子集与最佳质量双赛道。矩阵可独立判定;未实现/未验证进固定分母;
 *  排除项显式登记且永不计成通过;删分母、改权重、缺证据均使判定无效。 */

export const TARGET_MATRIX_SCHEMA_VERSION = 2 as const;
export const TARGET_TRACKS = ["common-baseline", "best-quality"] as const;
export type TargetTrack = (typeof TARGET_TRACKS)[number];

/** 六类工业负载是每张矩阵的必选任务下限(验证手册 §3);引擎可追加,不可删减。 */
export const REQUIRED_LOAD_CLASSES = [
  "factory-instances",
  "heterogeneous-bim",
  "far-origin-campus",
  "dynamic-workcell",
  "mixed-dashboard",
  "appearance-showcase",
] as const;

export interface EngineTargetIdentity {
  readonly version: string;
  readonly renderer: string;
  readonly platform: string;
  /** 渲染器档位(如 URP/Forth+/Forward+);公共子集与最佳质量可分别声明。 */
  readonly rendererProfile?: string;
}

export interface TargetCase {
  readonly id: string;
  readonly track: TargetTrack;
  readonly critical: boolean;
  readonly loadClass: (typeof REQUIRED_LOAD_CLASSES)[number];
  readonly weight: number;
  readonly domain: keyof typeof CAPABILITY_DOMAIN_WEIGHTS;
  /** 质量声明:该 case 在哪个质量口径下比较,禁止跨赛道混算。 */
  readonly quality: "equivalent" | "best";
}

export interface RequiredCapability {
  readonly id: string;
  readonly domain: keyof typeof CAPABILITY_DOMAIN_WEIGHTS;
  readonly weight: number;
  readonly critical: boolean;
}

export interface ForbiddenRegression {
  readonly id: string;
  readonly description: string;
}

export interface MatrixExclusion {
  readonly id: string;
  readonly reason: string;
  /** 排除必须引用显式决议(RFC/用户指令),否则视为无效矩阵。 */
  readonly ruling: string;
}

export interface EngineTargetMatrix {
  readonly schema: "deep-engine.benchmark-target-matrix";
  readonly schemaVersion: typeof TARGET_MATRIX_SCHEMA_VERSION;
  readonly reference: BenchmarkReference;
  readonly engine: EngineTargetIdentity;
  readonly cases: readonly TargetCase[];
  readonly requiredCapabilities: readonly RequiredCapability[];
  readonly forbiddenRegressions: readonly ForbiddenRegression[];
  readonly exclusions: readonly MatrixExclusion[];
}

export interface TargetRunEvidenceEntry {
  readonly status: "passed" | "failed" | "unverified";
  readonly evidenceIds: readonly string[];
}

/** 一次判定的输入证据;缺失条目按 unverified 计入分母,不构造有利结论。 */
export interface TargetRunEvidence {
  readonly cases: Readonly<Record<string, TargetRunEvidenceEntry>>;
  readonly capabilities: Readonly<Record<string, TargetRunEvidenceEntry>>;
  readonly regressions: Readonly<Record<string, { readonly observed: boolean; readonly evidenceIds: readonly string[] }>>;
}

export interface TargetMatrixVerdict {
  readonly reference: BenchmarkReference;
  readonly valid: boolean;
  readonly passed: boolean;
  /** 分母固定:全部必选 case + 必选能力(排除项不在内)。 */
  readonly denominator: number;
  readonly passedCount: number;
  readonly unverified: readonly string[];
  readonly failed: readonly string[];
  readonly regressionViolations: readonly string[];
  readonly issues: readonly string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DOMAINS = Object.keys(CAPABILITY_DOMAIN_WEIGHTS) as (keyof typeof CAPABILITY_DOMAIN_WEIGHTS)[];
const LOAD_CLASSES = new Set<string>(REQUIRED_LOAD_CLASSES);

/** 构造并校验一张引擎目标矩阵;任何形状错误在此拒绝,不进入判定。 */
export function createEngineTargetMatrix(matrix: EngineTargetMatrix): EngineTargetMatrix {
  const issues = validateMatrix(matrix);
  if (issues.length) throw new Error(`invalid target matrix for ${matrix.reference}: ${issues.join("; ")}`);
  return matrix;
}

export function validateMatrix(matrix: EngineTargetMatrix): readonly string[] {
  const issues: string[] = [];
  if (matrix.schema !== "deep-engine.benchmark-target-matrix" || matrix.schemaVersion !== TARGET_MATRIX_SCHEMA_VERSION) {
    issues.push("schema identity mismatch");
  }
  if (!matrix.engine.version.trim() || !matrix.engine.renderer.trim() || !matrix.engine.platform.trim()) {
    issues.push("engine version/renderer/platform must be declared");
  }
  if (matrix.reference === "bevy") {
    if (!/^0\.19(?:\.|$)/.test(matrix.engine.version)) issues.push("Bevy matrix must pin a 0.19 release");
    if (!/wgpu/i.test(matrix.engine.renderer)) issues.push("Bevy matrix must declare its wgpu renderer");
  }
  const caseIds = new Set<string>();
  const domainTotals = Object.fromEntries(DOMAINS.map(domain => [domain, 0])) as Record<string, number>;
  for (const required of REQUIRED_LOAD_CLASSES) {
    if (!matrix.cases.some(entry => entry.loadClass === required)) issues.push(`missing required load class ${required}`);
  }
  for (const entry of matrix.cases) {
    if (!ID.test(entry.id) || caseIds.has(entry.id)) issues.push(`invalid or duplicate case id ${entry.id}`);
    caseIds.add(entry.id);
    if (!TARGET_TRACKS.includes(entry.track)) issues.push(`case ${entry.id} track is invalid`);
    if (!LOAD_CLASSES.has(entry.loadClass)) issues.push(`case ${entry.id} load class is invalid`);
    if (!(entry.domain in CAPABILITY_DOMAIN_WEIGHTS)) issues.push(`case ${entry.id} domain is invalid`);
    else if (entry.weight <= 0 || !Number.isFinite(entry.weight)) issues.push(`case ${entry.id} weight is invalid`);
    else domainTotals[entry.domain] = (domainTotals[entry.domain] ?? 0) + entry.weight;
    if (!["equivalent", "best"].includes(entry.quality)) issues.push(`case ${entry.id} quality is invalid`);
    if (entry.track === "common-baseline" && entry.quality !== "equivalent") {
      issues.push(`case ${entry.id} mixes best quality into the common baseline`);
    }
  }
  for (const capability of matrix.requiredCapabilities) {
    if (!ID.test(capability.id)) issues.push(`invalid capability id ${capability.id}`);
    if (!(capability.domain in CAPABILITY_DOMAIN_WEIGHTS)) issues.push(`capability ${capability.id} domain is invalid`);
    else if (capability.weight <= 0 || !Number.isFinite(capability.weight)) issues.push(`capability ${capability.id} weight is invalid`);
    else domainTotals[capability.domain] = (domainTotals[capability.domain] ?? 0) + capability.weight;
  }
  // 改权重使矩阵无效:各域合计必须等于冻结的域权重。
  for (const domain of DOMAINS) {
    if (Math.abs((domainTotals[domain] ?? 0) - CAPABILITY_DOMAIN_WEIGHTS[domain]) > 1e-9) {
      issues.push(`${domain} weights total ${domainTotals[domain]}, expected ${CAPABILITY_DOMAIN_WEIGHTS[domain]}`);
    }
  }
  if (!matrix.cases.length || !matrix.requiredCapabilities.length) issues.push("denominator must not be empty");
  if (!matrix.forbiddenRegressions.length) issues.push("forbidden regressions must be declared");
  for (const regression of matrix.forbiddenRegressions) {
    if (!ID.test(regression.id) || !regression.description.trim()) issues.push(`invalid forbidden regression ${regression.id}`);
  }
  const excluded = new Set(matrix.exclusions.map(entry => entry.id));
  for (const exclusion of matrix.exclusions) {
    if (!ID.test(exclusion.id) || !exclusion.reason.trim() || !exclusion.ruling.trim()) {
      issues.push(`exclusion ${exclusion.id} needs id, reason and ruling`);
    }
    if (caseIds.has(exclusion.id)) issues.push(`exclusion ${exclusion.id} must not also be a required case`);
  }
  return issues;
}

/** 独立判定一张矩阵;未验证保持 unverified,排除项不出现在任何通过集合里。 */
export function evaluateEngineTargetMatrix(matrix: EngineTargetMatrix, evidence: TargetRunEvidence): TargetMatrixVerdict {
  const issues: string[] = [...validateMatrix(matrix)];
  const unverified: string[] = [], failed: string[] = [], regressionViolations: string[] = [];
  let passedCount = 0;
  const denominator = matrix.cases.length + matrix.requiredCapabilities.length;
  const excluded = new Set(matrix.exclusions.map(entry => entry.id));
  if (issues.length) {
    return { reference: matrix.reference, valid: false, passed: false, denominator: 0,
      passedCount: 0, unverified, failed, regressionViolations, issues };
  }
  // 引擎身份未锁定(版本未冻结)的矩阵永远不能判 passed——不允许“先过再说”。
  const identityLocked = matrix.engine.version.trim().toLowerCase() !== "unlocked";
  for (const entry of matrix.cases) {
    const observed = evidence.cases[entry.id];
    if (!observed || observed.status === "unverified") {
      unverified.push(entry.id);
      if (entry.critical) issues.push(`critical case ${entry.id} is unverified`);
      continue;
    }
    if (observed.status === "failed") {
      failed.push(entry.id);
      if (entry.critical) issues.push(`critical case ${entry.id} failed`);
      continue;
    }
    if (!observed.evidenceIds.length) {
      issues.push(`case ${entry.id} passed without evidence`);
      unverified.push(entry.id);
      continue;
    }
    passedCount += 1;
  }
  for (const capability of matrix.requiredCapabilities) {
    const observed = evidence.capabilities[capability.id];
    if (!observed || observed.status === "unverified") {
      unverified.push(capability.id);
      if (capability.critical) issues.push(`critical capability ${capability.id} is unverified`);
      continue;
    }
    if (observed.status === "failed") {
      failed.push(capability.id);
      if (capability.critical) issues.push(`critical capability ${capability.id} failed`);
      continue;
    }
    if (!observed.evidenceIds.length) {
      issues.push(`capability ${capability.id} passed without evidence`);
      unverified.push(capability.id);
      continue;
    }
    passedCount += 1;
  }
  for (const regression of matrix.forbiddenRegressions) {
    const observed = evidence.regressions[regression.id];
    if (!observed) {
      issues.push(`forbidden regression ${regression.id} has no observation`);
      continue;
    }
    if (observed.observed) {
      regressionViolations.push(regression.id);
      if (!observed.evidenceIds.length) issues.push(`regression ${regression.id} observed without evidence`);
    }
  }
  // 排除项只允许出现在 exclusions 里;它若出现在证据中视为越权评分。
  for (const id of Object.keys(evidence.cases)) {
    if (excluded.has(id)) issues.push(`excluded ${id} must not carry scored evidence`);
  }
  const passed = issues.length === 0 && identityLocked && failed.length === 0
    && unverified.length === 0 && regressionViolations.length === 0;
  return { reference: matrix.reference, valid: true, passed,
    denominator, passedCount, unverified, failed, regressionViolations, issues };
}
