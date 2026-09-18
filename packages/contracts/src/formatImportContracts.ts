/**
 * 工业三维格式导入的四类合同骨架（PLAN-03 第一批）：
 * SourceBundleRecord / ImportRecipe / CoordinateFrameV1 / QualityReport。
 *
 * 边界声明：本文件只声明数据合同与运行时校验，不执行任何转换、不接线任务
 * 队列、不验证真实样本；转换执行、队列接线与真实语料验收分属 PLAN-04 /
 * PLAN-07 与后续阶段，出现某个 sourceFormat 枚举值不代表该格式已支持。
 */

/** 合同骨架识别的源方向；这是输入枚举，不是支持声明，能力状态仍由 modelFormatCatalog 拥有。 */
export const IMPORT_SOURCE_FORMATS = [
  "jt", "parasolid", "rvt", "e57", "las", "laz", "copc", "3dtiles", "3dm", "solidworks",
] as const;
export type ImportSourceFormat = (typeof IMPORT_SOURCE_FORMATS)[number];

/** SHA-256 摘要只接受小写十六进制；与上传服务 digest 输出对齐，不接受大写或 SRI 前缀写法。 */
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** 来源身份：原始文件永久保留，运行时资产必须能回溯到这一条记录。 */
export interface SourceBundleRecord {
  readonly schemaVersion: 1;
  readonly sourceName: string;
  readonly sourceFormat: ImportSourceFormat;
  /** 原始源文件 SHA-256（小写十六进制），由服务端计算，不接受客户端自报。 */
  readonly contentHash: string;
  /** 外部来源 URI；与 bundledPath 至少提供其一。 */
  readonly sourceUri?: string;
  /** 随包相对路径；不允许绝对路径或 `..` 逃逸。 */
  readonly bundledPath?: string;
  /** 许可标识 reference（SPDX ID 或随包许可文档引用）；本合同不解析许可条款。 */
  readonly licenseReference: string;
}

export function assertSourceBundleRecord(value: unknown): asserts value is SourceBundleRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SourceBundleRecord 必须是对象");
  const record = value as Record<string, unknown>;
  const fields = new Set(["schemaVersion", "sourceName", "sourceFormat", "contentHash", "sourceUri", "bundledPath", "licenseReference"]);
  if (Object.keys(record).some(key => !fields.has(key))) throw new Error("SourceBundleRecord 包含未知字段");
  if (record.schemaVersion !== 1) throw new Error("仅支持 SourceBundleRecord v1");
  if (typeof record.sourceName !== "string" || !record.sourceName) throw new Error("SourceBundleRecord 必须指定来源名称");
  if (typeof record.sourceFormat !== "string" || !(IMPORT_SOURCE_FORMATS as readonly string[]).includes(record.sourceFormat)) {
    throw new Error(`SourceBundleRecord 来源格式必须是 ${IMPORT_SOURCE_FORMATS.join("、")} 之一`);
  }
  if (typeof record.contentHash !== "string" || !SHA256_HEX.test(record.contentHash)) {
    throw new Error("SourceBundleRecord contentHash 必须是小写十六进制 SHA-256");
  }
  if (record.sourceUri !== undefined && (typeof record.sourceUri !== "string" || !record.sourceUri)) throw new Error("SourceBundleRecord sourceUri 必须是非空字符串");
  if (record.bundledPath !== undefined && (typeof record.bundledPath !== "string" || !isRelativePath(record.bundledPath))) throw new Error("SourceBundleRecord bundledPath 必须是不含 .. 的相对路径");
  if (record.sourceUri === undefined && record.bundledPath === undefined) throw new Error("SourceBundleRecord 必须提供 sourceUri 或 bundledPath 之一");
  if (typeof record.licenseReference !== "string" || !record.licenseReference) throw new Error("SourceBundleRecord 必须提供许可标识 reference");
}

/**
 * 坐标帧合同：与 apps/web `sceneLocalCoordinates.ts` 的 SceneLocalCoordinateFrame
 * 及 deep-engine `RUNTIME_COORDINATE_PROFILE`（scene-local-coordinates-v1）同一语义。
 * contracts 位于依赖下游不能反向 import，这里以逐字段等值断言锁定；上游放宽或
 * 修改任一值都必须同步本常量，否则两端的坐标帧互不认账。
 */
export const SCENE_LOCAL_COORDINATE_PROFILE_V1 = Object.freeze({
  id: "scene-local-coordinates-v1",
  unit: "scene-unit",
  originGrid: 1000,
  maxRoundTripError: 0.000001,
  maxFloat32CoordinateError: 0.001,
} as const);

export interface CoordinateFrameV1 {
  readonly schemaVersion: 1;
  readonly profile: typeof SCENE_LOCAL_COORDINATE_PROFILE_V1;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
}

export function assertCoordinateFrameV1(value: unknown): asserts value is CoordinateFrameV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CoordinateFrameV1 必须是对象");
  const record = value as Record<string, unknown>;
  const fields = new Set(["schemaVersion", "profile", "origin"]);
  if (Object.keys(record).some(key => !fields.has(key))) throw new Error("CoordinateFrameV1 包含未知字段");
  if (record.schemaVersion !== 1) throw new Error("仅支持 CoordinateFrameV1 v1");
  const profile = record.profile as Record<string, unknown> | null | undefined;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("CoordinateFrameV1 profile 必须是对象");
  for (const [key, expected] of Object.entries(SCENE_LOCAL_COORDINATE_PROFILE_V1)) {
    if (profile[key] !== expected) throw new Error(`CoordinateFrameV1 profile.${key} 与 scene-local-coordinates-v1 不一致`);
  }
  if (Object.keys(profile).some(key => !(key in SCENE_LOCAL_COORDINATE_PROFILE_V1))) throw new Error("CoordinateFrameV1 profile 包含未知字段");
  const origin = record.origin as Record<string, unknown> | null | undefined;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) throw new Error("CoordinateFrameV1 origin 必须是对象");
  if (Object.keys(origin).some(key => !["x", "y", "z"].includes(key))) throw new Error("CoordinateFrameV1 origin 包含未知字段");
  for (const axis of ["x", "y", "z"] as const) {
    const coordinate = origin[axis], grid = SCENE_LOCAL_COORDINATE_PROFILE_V1.originGrid;
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) throw new Error(`CoordinateFrameV1 origin.${axis} 必须为有限数值`);
    if (coordinate % grid !== 0) throw new Error(`CoordinateFrameV1 origin.${axis} 必须落在 ${grid} 场景单位网格上`);
  }
}

/** 目标 GLB 变体声明；variantId 是声明性标识，不代表转换已执行或已验证。 */
export interface ImportTargetVariant {
  readonly container: "glb";
  readonly variantId: string;
}

export type ImportLengthUnit = "millimeter" | "centimeter" | "meter" | "inch" | "foot" | "scene-unit";

/** 单位处理参数；scaleToTarget 是乘到场景单位的正系数，转换本身仍由 Worker 声明实现。 */
export interface ImportUnitPolicy {
  readonly sourceUnit: ImportLengthUnit;
  readonly scaleToTarget: number;
}

export type ImportUpAxis = "y" | "z";
export type ImportHandedness = "right-handed" | "left-handed";

/** 坐标处理参数；targetProfile 固定指向 scene-local 坐标帧，不引入第二种目标帧。 */
export interface ImportCoordinatePolicy {
  readonly sourceUpAxis: ImportUpAxis;
  readonly sourceHandedness: ImportHandedness;
  readonly targetProfile: typeof SCENE_LOCAL_COORDINATE_PROFILE_V1["id"];
}

/**
 * 抽稀/LOD 策略。与 Native 数据通道（data_window ChannelAccounting）同一纪律：
 * rule 是本 recipe 声明使用的唯一抽稀规则名，QualityReport 必须按同名规则报告，
 * 报告其他规则即合同违规。
 */
export type ImportDecimationRule = "none" | "equal-stride-first-last" | "triangle-budget";
export const IMPORT_DECIMATION_RULES: readonly ImportDecimationRule[] = ["none", "equal-stride-first-last", "triangle-budget"];

export interface ImportDecimationPolicy {
  readonly rule: ImportDecimationRule;
  /** rule 为 triangle-budget 时必填的目标三角数上限；其他规则禁止携带。 */
  readonly maxTriangles?: number;
}

/** 每步可复现命令记录；仅作为审计记录保存，本合同不解析也不执行。 */
export interface ImportRecipeStep {
  readonly index: number;
  readonly name: string;
  readonly command: string;
}

export interface ImportRecipe {
  readonly schemaVersion: 1;
  readonly sourceFormat: ImportSourceFormat;
  readonly targetVariant: ImportTargetVariant;
  readonly unitPolicy: ImportUnitPolicy;
  readonly coordinatePolicy: ImportCoordinatePolicy;
  readonly decimation: ImportDecimationPolicy;
  readonly steps: readonly ImportRecipeStep[];
}

const IMPORT_LENGTH_UNITS: readonly string[] = ["millimeter", "centimeter", "meter", "inch", "foot", "scene-unit"];

function expectNestedObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}
function rejectUnknownFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error(`${label} 包含未知字段`);
}

export function assertImportRecipe(value: unknown): asserts value is ImportRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ImportRecipe 必须是对象");
  const record = value as Record<string, unknown>;
  rejectUnknownFields(record, ["schemaVersion", "sourceFormat", "targetVariant", "unitPolicy", "coordinatePolicy", "decimation", "steps"], "ImportRecipe");
  if (record.schemaVersion !== 1) throw new Error("仅支持 ImportRecipe v1");
  if (typeof record.sourceFormat !== "string" || !(IMPORT_SOURCE_FORMATS as readonly string[]).includes(record.sourceFormat)) {
    throw new Error(`ImportRecipe 来源格式必须是 ${IMPORT_SOURCE_FORMATS.join("、")} 之一`);
  }
  const targetVariant = expectNestedObject(record.targetVariant, "ImportRecipe targetVariant");
  rejectUnknownFields(targetVariant, ["container", "variantId"], "ImportRecipe targetVariant");
  if (targetVariant.container !== "glb") throw new Error("ImportRecipe 目标容器当前仅支持 glb");
  if (typeof targetVariant.variantId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(targetVariant.variantId)) throw new Error("ImportRecipe variantId 必须是小写字母开头的路径安全标识");
  const unitPolicy = expectNestedObject(record.unitPolicy, "ImportRecipe unitPolicy");
  rejectUnknownFields(unitPolicy, ["sourceUnit", "scaleToTarget"], "ImportRecipe unitPolicy");
  if (typeof unitPolicy.sourceUnit !== "string" || !IMPORT_LENGTH_UNITS.includes(unitPolicy.sourceUnit)) throw new Error("ImportRecipe sourceUnit 必须是受支持的长度单位");
  if (typeof unitPolicy.scaleToTarget !== "number" || !Number.isFinite(unitPolicy.scaleToTarget) || unitPolicy.scaleToTarget <= 0) throw new Error("ImportRecipe scaleToTarget 必须是正有限数");
  const coordinatePolicy = expectNestedObject(record.coordinatePolicy, "ImportRecipe coordinatePolicy");
  rejectUnknownFields(coordinatePolicy, ["sourceUpAxis", "sourceHandedness", "targetProfile"], "ImportRecipe coordinatePolicy");
  if (coordinatePolicy.sourceUpAxis !== "y" && coordinatePolicy.sourceUpAxis !== "z") throw new Error("ImportRecipe sourceUpAxis 必须是 y 或 z");
  if (coordinatePolicy.sourceHandedness !== "right-handed" && coordinatePolicy.sourceHandedness !== "left-handed") throw new Error("ImportRecipe sourceHandedness 必须是 right-handed 或 left-handed");
  if (coordinatePolicy.targetProfile !== SCENE_LOCAL_COORDINATE_PROFILE_V1.id) throw new Error(`ImportRecipe targetProfile 必须是 ${SCENE_LOCAL_COORDINATE_PROFILE_V1.id}`);
  const decimation = expectNestedObject(record.decimation, "ImportRecipe decimation");
  rejectUnknownFields(decimation, ["rule", "maxTriangles"], "ImportRecipe decimation");
  if (typeof decimation.rule !== "string" || !IMPORT_DECIMATION_RULES.includes(decimation.rule as ImportDecimationRule)) {
    throw new Error(`ImportRecipe decimation rule 必须是 ${IMPORT_DECIMATION_RULES.join("、")} 之一`);
  }
  if (decimation.rule === "triangle-budget") {
    if (typeof decimation.maxTriangles !== "number" || !Number.isInteger(decimation.maxTriangles) || decimation.maxTriangles < 1) throw new Error("ImportRecipe triangle-budget 规则必须提供正整数 maxTriangles");
  } else if (decimation.maxTriangles !== undefined) {
    throw new Error("ImportRecipe 仅 triangle-budget 规则允许携带 maxTriangles");
  }
  if (!Array.isArray(record.steps) || record.steps.length === 0) throw new Error("ImportRecipe 必须记录至少一个步骤");
  record.steps.forEach((step, position) => {
    const stepRecord = expectNestedObject(step, "ImportRecipe 步骤");
    rejectUnknownFields(stepRecord, ["index", "name", "command"], "ImportRecipe 步骤");
    if (stepRecord.index !== position + 1) throw new Error("ImportRecipe 步骤 index 必须从 1 连续递增");
    if (typeof stepRecord.name !== "string" || !stepRecord.name) throw new Error("ImportRecipe 步骤必须提供名称");
    if (typeof stepRecord.command !== "string" || !stepRecord.command) throw new Error("ImportRecipe 步骤必须提供可复现命令");
  });
}

/** 几何计数：与 Native 数据通道 ChannelAccounting 的 input/dropped 命名精神一致。 */
export interface ImportGeometryCounters {
  readonly inputPoints: number;
  readonly inputTriangles: number;
  readonly droppedPoints: number;
  readonly droppedTriangles: number;
}

/** 抽稀核算：只允许报告 rule 声明的规则，output 与 input 属同一原始输入集合。 */
export interface ImportDecimationAccounting {
  readonly rule: ImportDecimationRule;
  readonly inputTriangles: number;
  readonly outputTriangles: number;
}

/** 转换质量报告；warnings 是机器可读的诊断列表，任务成功不等于模型 ready。 */
export interface QualityReport {
  readonly schemaVersion: 1;
  readonly counters: ImportGeometryCounters;
  readonly decimation: ImportDecimationAccounting;
  readonly warnings: readonly string[];
}

export function assertQualityReport(value: unknown): asserts value is QualityReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QualityReport 必须是对象");
  const record = value as Record<string, unknown>;
  rejectUnknownFields(record, ["schemaVersion", "counters", "decimation", "warnings"], "QualityReport");
  if (record.schemaVersion !== 1) throw new Error("仅支持 QualityReport v1");
  const counters = expectNestedObject(record.counters, "QualityReport counters");
  rejectUnknownFields(counters, ["inputPoints", "inputTriangles", "droppedPoints", "droppedTriangles"], "QualityReport counters");
  for (const key of ["inputPoints", "inputTriangles", "droppedPoints", "droppedTriangles"] as const) {
    if (typeof counters[key] !== "number" || !Number.isInteger(counters[key]) || (counters[key] as number) < 0) throw new Error(`QualityReport counters.${key} 必须是非负整数`);
  }
  if ((counters.droppedPoints as number) > (counters.inputPoints as number)) throw new Error("QualityReport 丢弃点数不能超过输入点数");
  if ((counters.droppedTriangles as number) > (counters.inputTriangles as number)) throw new Error("QualityReport 丢弃三角数不能超过输入三角数");
  const decimation = expectNestedObject(record.decimation, "QualityReport decimation");
  rejectUnknownFields(decimation, ["rule", "inputTriangles", "outputTriangles"], "QualityReport decimation");
  if (typeof decimation.rule !== "string" || !IMPORT_DECIMATION_RULES.includes(decimation.rule as ImportDecimationRule)) {
    throw new Error(`QualityReport decimation rule 必须是 ${IMPORT_DECIMATION_RULES.join("、")} 之一`);
  }
  for (const key of ["inputTriangles", "outputTriangles"] as const) {
    if (typeof decimation[key] !== "number" || !Number.isInteger(decimation[key]) || (decimation[key] as number) < 0) throw new Error(`QualityReport decimation.${key} 必须是非负整数`);
  }
  if ((decimation.inputTriangles as number) !== (counters.inputTriangles as number)) throw new Error("QualityReport decimation.inputTriangles 必须与 counters.inputTriangles 一致");
  if ((decimation.outputTriangles as number) > (decimation.inputTriangles as number)) throw new Error("QualityReport decimation.outputTriangles 不能超过 inputTriangles");
  if (decimation.rule === "none" && (decimation.outputTriangles as number) !== (decimation.inputTriangles as number)) throw new Error("QualityReport rule 为 none 时不得改变三角数");
  if (!Array.isArray(record.warnings)) throw new Error("QualityReport warnings 必须是字符串数组");
  for (const warning of record.warnings) {
    if (typeof warning !== "string" || !warning) throw new Error("QualityReport 每条警告必须是非空字符串");
  }
}

function isRelativePath(value: string): boolean {
  return !value.startsWith("/") && !value.includes("..") && !/^[a-zA-Z]:/.test(value) && value !== ".";
}
