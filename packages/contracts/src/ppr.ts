/**
 * PD Lite 的最小 PPR/BOP 快照合同。
 * 这是工艺规划的可追溯输入，不承担 PLM 的变更审批、主数据同步或报价职责。
 */

export type PprComponentKind = "product" | "part";
export type PprResourceKind = "station" | "equipment" | "robot" | "tool" | "person";
export type PprComponentRole = "input" | "output" | "in-process";
export type PprExternalReferenceKind = "scene" | "object" | "script" | "study";

/** 场景、对象、脚本和 Study 只保存 ID；存在性由调用方所属运行时解析。 */
export interface PprExternalReference {
  kind: PprExternalReferenceKind;
  id: string;
}

export interface PprCondition {
  /** 可读、可追溯的适用条件，不在 Lite 引擎中执行表达式。 */
  expression: string;
  description?: string;
}

export interface PprComponent {
  id: string;
  name: string;
  kind: PprComponentKind;
  /** 非根节点指向其上级产品或零部件，形成最小 BOM。 */
  parentComponentId?: string;
  variantIds?: string[];
  condition?: PprCondition;
  references?: PprExternalReference[];
}

export interface PprOperationComponentRef {
  componentId: string;
  role: PprComponentRole;
  quantity?: number;
}

export interface PprOperation {
  id: string;
  name: string;
  /** 标准工时，单位分钟；不表达换型、批量或随机波动。 */
  standardTimeMinutes: number;
  componentRefs: PprOperationComponentRef[];
  variantIds?: string[];
  condition?: PprCondition;
  references?: PprExternalReference[];
}

export interface PprPrecedenceRelation {
  id: string;
  predecessorOperationId: string;
  successorOperationId: string;
  /** 结束到开始的最小等待时间，单位分钟。 */
  minimumLagMinutes?: number;
  condition?: PprCondition;
}

export interface PprResource {
  id: string;
  name: string;
  kind: PprResourceKind;
  /** 同时可服务的单位数，缺省为 1。 */
  capacity?: number;
  variantIds?: string[];
  condition?: PprCondition;
  references?: PprExternalReference[];
}

export interface PprOperationResourceAssignment {
  id: string;
  operationId: string;
  resourceId: string;
  /** 本工序执行时占用的资源单位数，缺省为 1。 */
  requiredCapacity?: number;
}

/** 一个版本是可比较、可复现的工艺快照，不会就地覆盖历史版本。 */
export interface PprBopVersion {
  id: string;
  planId: string;
  version: string;
  name: string;
  createdAt: string;
  basedOnVersionId?: string;
  components: PprComponent[];
  operations: PprOperation[];
  precedenceRelations: PprPrecedenceRelation[];
  resources: PprResource[];
  resourceAssignments: PprOperationResourceAssignment[];
  variantIds?: string[];
  condition?: PprCondition;
  references?: PprExternalReference[];
}

/** 创建后由服务端补齐不可变版本 ID、创建时间和默认版本号。 */
export type PprBopVersionDraft = Omit<PprBopVersion, "id" | "createdAt" | "version"> & {
  version?: string;
};
