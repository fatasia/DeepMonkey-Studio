/**
 * 制造数字线程收敛层(PS/PD/Plant R0 合同)。
 * 规格 `ps-pd-plant-full-replacement-upgrade-plan-2026-09-25.md` 第 3 节的 9 个统一对象。
 * 本层不复制任何既有模型字段:payload 一律引用既有合同
 * (PprComponent / PprBopVersion / PlantLiteModel / VirtualDebugScenario / WorkcellAuditInput /
 *  SimulationEntityState / IndustrialStudyRecord),新增的只有对象头、生命周期与断链诊断。
 */

import { isPathSafeResourceId } from "./resourceId.js";
import { fingerprint64Labeled } from "./fingerprint.js";
import type { SimulationEntityState } from "./simulationEntities.js";
import type { PprBopVersion, PprComponent, PprResource } from "./ppr.js";
import type {
  PlantLiteModel,
  PlantLiteSimulationLimits,
  PlantLiteTraceCaptureOptions,
} from "./plantLiteModel.js";
import type { PlantTransportNetwork } from "./plantTransportNetwork.js";
import type { VirtualDebugScenario } from "./virtualCommissioning.js";
import type { WorkcellAuditInput } from "./workcellValidation.js";

export type DigitalThreadObjectKind =
  | "product-definition"
  | "manufacturing-process"
  | "resource-definition"
  | "scene-binding"
  | "simulation-study"
  | "control-scenario"
  | "validation-case"
  | "study-result"
  | "release-baseline";

export type DigitalThreadObjectStatus = "draft" | "frozen" | "deprecated";

export interface DigitalThreadChangeEntry {
  version: number;
  at: string;
  summary: string;
  author?: string;
}

export interface DigitalThreadObjectHeader {
  /** 全线程稳定标识;路径安全;一经创建不改,删除只能经断链诊断暴露。 */
  stableId: string;
  kind: DigitalThreadObjectKind;
  /** 从 1 起单调递增;任何 payload 修改必须 bump。 */
  version: number;
  status: DigitalThreadObjectStatus;
  createdAt: string;
  updatedAt: string;
  provenance: {
    origin: "authored" | "imported" | "derived";
    /** 导入/派生来源的追溯引用(文件哈希、上游 Study 等),原样保存不解释。 */
    sourceRef?: string;
  };
  /** 省略表示沿用场景规范坐标帧(right-handed Y-up metre)。 */
  coordinateFrame?: string;
  changeLog: DigitalThreadChangeEntry[];
}

export interface ProductDefinitionPayload {
  rootComponent: PprComponent;
}

export interface ManufacturingProcessPayload {
  bop: PprBopVersion;
}

export interface ResourceDefinitionPayload {
  resources: PprResource[];
}

export interface SceneBindingPayload {
  sceneId: string;
  entities: SimulationEntityState[];
}

/** Plant 仿真 Study 输入:模型、随机性与统计口径一起冻结,复现才有意义。 */
export interface PlantSimulationStudyPayload {
  engineId: "plant-lite-des";
  model: PlantLiteModel;
  transportNetwork?: PlantTransportNetwork;
  seed: string | number;
  replications?: number;
  limits?: PlantLiteSimulationLimits;
  trace?: PlantLiteTraceCaptureOptions;
}

export interface ControlScenarioPayload {
  scenario: VirtualDebugScenario;
}

export interface WorkcellValidationCasePayload {
  kind: "workcell-audit";
  input: WorkcellAuditInput;
}

export interface ControlValidationCasePayload {
  kind: "virtual-debug";
  scenarioStableId: string;
}

export type ValidationCasePayload = WorkcellValidationCasePayload | ControlValidationCasePayload;

/** StudyResult 是 IndustrialStudyRecord 的挂接,不复制指标;读取端按 recordId 解析。 */
export interface StudyResultPayload {
  studyRecordId: string;
}

export interface ReleaseBaselinePayload {
  /** 基线冻结的对象版本清单;version 必须对应该对象当时真实版本。 */
  entries: Array<{ stableId: string; version: number }>;
  approvedBy?: string;
  note?: string;
}

/** 对象 = 头 + 判别 payload;kind 同时存在于头(宽)与判别位(窄),交叉后以窄为准。 */
export type DigitalThreadObject =
  | (DigitalThreadObjectHeader & { kind: "product-definition"; payload: ProductDefinitionPayload })
  | (DigitalThreadObjectHeader & { kind: "manufacturing-process"; payload: ManufacturingProcessPayload })
  | (DigitalThreadObjectHeader & { kind: "resource-definition"; payload: ResourceDefinitionPayload })
  | (DigitalThreadObjectHeader & { kind: "scene-binding"; payload: SceneBindingPayload })
  | (DigitalThreadObjectHeader & { kind: "simulation-study"; payload: PlantSimulationStudyPayload })
  | (DigitalThreadObjectHeader & { kind: "control-scenario"; payload: ControlScenarioPayload })
  | (DigitalThreadObjectHeader & { kind: "validation-case"; payload: ValidationCasePayload })
  | (DigitalThreadObjectHeader & { kind: "study-result"; payload: StudyResultPayload })
  | (DigitalThreadObjectHeader & { kind: "release-baseline"; payload: ReleaseBaselinePayload });

/** 对象间显式引用;跨对象依赖只允许走 link,禁止 payload 里藏第二套 ID 体系。 */
export interface DigitalThreadLink {
  fromStableId: string;
  toStableId: string;
  role: string;
}

export class DigitalThreadIdentityError extends Error {}

export function createObjectHeader(input: {
  stableId: string;
  kind: DigitalThreadObjectKind;
  at: string;
  origin?: DigitalThreadObjectHeader["provenance"]["origin"];
  sourceRef?: string;
  coordinateFrame?: string;
  author?: string;
}): DigitalThreadObjectHeader {
  if (!isPathSafeResourceId(input.stableId)) {
    throw new DigitalThreadIdentityError(`stableId 非法:${input.stableId}`);
  }
  return {
    stableId: input.stableId,
    kind: input.kind,
    version: 1,
    status: "draft",
    createdAt: input.at,
    updatedAt: input.at,
    provenance: input.sourceRef
      ? { origin: input.origin ?? "authored", sourceRef: input.sourceRef }
      : { origin: input.origin ?? "authored" },
    ...(input.coordinateFrame !== undefined ? { coordinateFrame: input.coordinateFrame } : {}),
    changeLog: [input.author === undefined
      ? { version: 1, at: input.at, summary: "created" }
      : { version: 1, at: input.at, summary: "created", author: input.author }],
  };
}

/** 不可变版本递增:返回新对象;被冻结对象拒绝修改,先显式解冻(新 entry 记录)。 */
export function bumpObjectVersion<T extends DigitalThreadObject>(
  object: T,
  input: { at: string; summary: string; author?: string },
): T {
  if (object.status === "frozen") {
    throw new DigitalThreadIdentityError(`对象 ${object.stableId} 已冻结,禁止直接修改`);
  }
  const version = object.version + 1;
  const changeEntry: DigitalThreadChangeEntry = input.author === undefined
    ? { version, at: input.at, summary: input.summary }
    : { version, at: input.at, summary: input.summary, author: input.author };
  return {
    ...object,
    version,
    updatedAt: input.at,
    changeLog: [...object.changeLog, changeEntry],
  };
}

export function setObjectStatus<T extends DigitalThreadObject>(
  object: T,
  status: DigitalThreadObjectStatus,
  input: { at: string; summary: string; author?: string },
): T {
  const bumped = bumpObjectVersion(object, input);
  return { ...bumped, status };
}

/** 对象指纹:头与 payload 分标签掺入;payload 结构变化必然改变指纹。 */
export function fingerprintDigitalThreadObject(object: DigitalThreadObject): string {
  const { payload, ...header } = object;
  return fingerprint64Labeled([
    ["header", header],
    ["payload", payload],
  ]);
}

export interface DigitalThreadDiagnostic {
  kind: "broken-link" | "duplicate-stable-id" | "invalid-stable-id" | "baseline-version-mismatch";
  fromStableId?: string;
  toStableId?: string;
  message: string;
}

/**
 * 断链诊断是删除/改绑的唯一出口:只报告,不静默修复,不改写任何引用。
 * release-baseline 的版本不匹配同样在此暴露,禁止静默接受。
 */
export function diagnoseDigitalThread(objects: readonly DigitalThreadObject[]): DigitalThreadDiagnostic[] {
  const diagnostics: DigitalThreadDiagnostic[] = [];
  const byId = new Map<string, DigitalThreadObject>();
  for (const object of objects) {
    if (!isPathSafeResourceId(object.stableId)) {
      diagnostics.push({ kind: "invalid-stable-id", fromStableId: object.stableId, message: `stableId 非法:${object.stableId}` });
      continue;
    }
    const existing = byId.get(object.stableId);
    if (existing) {
      diagnostics.push({ kind: "duplicate-stable-id", fromStableId: object.stableId, message: `stableId 重复:${object.stableId}` });
      continue;
    }
    byId.set(object.stableId, object);
  }
  const links = collectThreadLinks(objects);
  for (const link of links) {
    if (!byId.has(link.toStableId)) {
      diagnostics.push({
        kind: "broken-link",
        fromStableId: link.fromStableId,
        toStableId: link.toStableId,
        message: `引用断裂:${link.fromStableId} 的 ${link.role} 指向不存在的 ${link.toStableId}`,
      });
    }
  }
  for (const object of objects) {
    if (object.kind !== "release-baseline") continue;
    for (const entry of object.payload.entries) {
      const target = byId.get(entry.stableId);
      if (!target) {
        diagnostics.push({ kind: "broken-link", fromStableId: object.stableId, toStableId: entry.stableId, message: `基线引用断裂:${entry.stableId}` });
        continue;
      }
      if (target.version !== entry.version) {
        diagnostics.push({
          kind: "baseline-version-mismatch",
          fromStableId: object.stableId,
          toStableId: entry.stableId,
          message: `基线版本漂移:${entry.stableId} 基线记录 v${entry.version},当前 v${target.version}`,
        });
      }
    }
  }
  return diagnostics;
}

/** 从对象 payload 推导线程内引用;payload 对既有合同(场景模型等)的引用不在此列。 */
export function collectThreadLinks(objects: readonly DigitalThreadObject[]): DigitalThreadLink[] {
  const links: DigitalThreadLink[] = [];
  for (const object of objects) {
    if (object.kind === "validation-case" && object.payload.kind === "virtual-debug") {
      links.push({ fromStableId: object.stableId, toStableId: object.payload.scenarioStableId, role: "control-scenario" });
    }
    if (object.kind === "study-result") {
      links.push({ fromStableId: object.stableId, toStableId: object.payload.studyRecordId, role: "study-record" });
    }
    if (object.kind === "release-baseline") {
      for (const entry of object.payload.entries) {
        links.push({ fromStableId: object.stableId, toStableId: entry.stableId, role: "baseline-entry" });
      }
    }
  }
  return links;
}
