import {
  isFreeJoint,
  jointIndexByName,
  poseFromRecord,
  type IKSkeleton,
  type IKSkeletonNode,
} from "./ikSkeleton";

/**
 * 关节映射表驱动的姿态重定向最小集。三档支持,不支持的情形一律显式报错、不做猜测:
 * - isomorphic 同构:同名关节集、类型与层级完全一致,按名直传;
 * - partial-joints 缺关节:目标可动关节集是源的同名同型子集,缺失关节被丢弃并如实上报;
 * - explicit-mapping 层级不同:调用方给出一对一显式映射(可带比例/偏移),层级差异不影响
 *   关节局部值的迁移;引用不存在、重复映射、跨类型映射均显式拒绝。
 * 限位在目标侧重新钳制(硬约束),被钳制的关节如实列入 clamped。
 */

export type RetargetTier = "isomorphic" | "partial-joints" | "explicit-mapping";

export interface RetargetJointMap {
  sourceJoint: string;
  targetJoint: string;
  /** 数值缩放(角度无量纲时通常 1;平移类按骨架比例),缺省 1。 */
  ratio?: number;
  /** 数值偏移(目标侧 SI 单位),缺省 0。 */
  offset?: number;
}

export interface RetargetMapping {
  tier: RetargetTier;
  entries: RetargetJointMap[];
}

export interface RetargetResult {
  /** 完整目标姿态:全部目标可动关节(未映射者置 0),不含 fixed/mimic。 */
  pose: Record<string, number>;
  /** 已迁移的目标关节名(映射顺序)。 */
  transferred: string[];
  /** 未映射而被丢弃的源可动关节名(源拓扑序)。 */
  dropped: string[];
  /** 迁移后因目标限位被钳制的目标关节名。 */
  clamped: string[];
}

interface FreeJointRecord {
  index: number;
  name: string;
  node: IKSkeletonNode;
}

function freeJointRecords(skeleton: IKSkeleton): FreeJointRecord[] {
  const records: FreeJointRecord[] = [];
  for (let index = 0; index < skeleton.nodes.length; index++) {
    const node = skeleton.nodes[index]!;
    if (isFreeJoint(node)) records.push({ index, name: node.name, node });
  }
  return records;
}

function freeJointTable(skeleton: IKSkeleton): Map<string, FreeJointRecord> {
  return new Map(freeJointRecords(skeleton).map(record => [record.name, record] as const));
}

function parentName(skeleton: IKSkeleton, record: FreeJointRecord): string | null {
  const parent = record.node.parent;
  return parent < 0 ? null : skeleton.nodes[parent]!.name;
}

/** 首子链静息长度比(启发式比例建议):沿每层第一个子关节累计 |restTranslation|,目标/源;源链长为 0 时返回 1。 */
export function suggestPrismaticRatio(source: IKSkeleton, target: IKSkeleton, sourceJoint: string, targetJoint: string): number {
  const restChainLength = (skeleton: IKSkeleton, name: string): number => {
    const start = jointIndexByName(skeleton, name);
    if (start === undefined) throw new Error(`骨架没有关节 ${name}`);
    let length = 0;
    let current = start;
    for (;;) {
      const children: number[] = [];
      for (let index = 0; index < skeleton.nodes.length; index++) {
        if (skeleton.nodes[index]!.parent === current) children.push(index);
      }
      if (children.length === 0) break;
      current = children[0]!;
      length += skeleton.nodes[current]!.restTranslation.length();
    }
    return length;
  };
  const sourceLength = restChainLength(source, sourceJoint);
  if (sourceLength <= 1e-9) return 1;
  return restChainLength(target, targetJoint) / sourceLength;
}

function assertEntryValue(entry: RetargetJointMap, key: "ratio" | "offset"): void {
  const value = entry[key];
  if (value !== undefined && !Number.isFinite(value)) throw new Error(`映射 ${entry.sourceJoint}→${entry.targetJoint} 的 ${key} 必须是有限数值`);
}

function requirePair(
  sourceTable: Map<string, FreeJointRecord>,
  targetTable: Map<string, FreeJointRecord>,
  entry: RetargetJointMap,
): { source: FreeJointRecord; target: FreeJointRecord } {
  const source = sourceTable.get(entry.sourceJoint);
  if (!source) throw new Error(`映射源关节 ${entry.sourceJoint} 不在源骨架的可动关节中`);
  const target = targetTable.get(entry.targetJoint);
  if (!target) throw new Error(`映射目标关节 ${entry.targetJoint} 不在目标骨架的可动关节中`);
  if (source.node.type !== target.node.type) {
    throw new Error(`映射 ${entry.sourceJoint}→${entry.targetJoint} 关节类型不一致(${source.node.type}/${target.node.type}),不支持跨类型映射`);
  }
  return { source, target };
}

function assertNoDuplicate(entries: readonly RetargetJointMap[]): void {
  const usedSources = new Set<string>();
  const usedTargets = new Set<string>();
  for (const entry of entries) {
    if (usedSources.has(entry.sourceJoint)) throw new Error(`映射源关节 ${entry.sourceJoint} 被重复使用`);
    if (usedTargets.has(entry.targetJoint)) throw new Error(`映射目标关节 ${entry.targetJoint} 被重复使用`);
    usedSources.add(entry.sourceJoint);
    usedTargets.add(entry.targetJoint);
  }
}

/** 同构映射:同名关节集、同型且父名层级完全一致;否则显式报错并指向显式映射。 */
export function buildIsomorphicMapping(source: IKSkeleton, target: IKSkeleton): RetargetMapping {
  const sourceFree = freeJointRecords(source);
  const targetFree = freeJointRecords(target);
  const compatible =
    sourceFree.length === targetFree.length &&
    sourceFree.every((record, index) => {
      const other = targetFree[index]!;
      return record.name === other.name && record.node.type === other.node.type && parentName(source, record) === parentName(target, other);
    });
  if (!compatible) throw new Error("两个骨架不同构(关节集、类型或层级不一致),请改用 buildExplicitMapping 显式映射");
  return { tier: "isomorphic", entries: sourceFree.map(record => ({ sourceJoint: record.name, targetJoint: record.name })) };
}

/**
 * 缺关节映射:目标可动关节集必须是源的同名同型子集(顺序按目标拓扑序),
 * 源上多出的关节进入 dropped;不满足子集关系显式报错。
 * 平移类关节自动带首子链静息长度比,处理骨架比例差异。
 */
export function buildPartialMapping(source: IKSkeleton, target: IKSkeleton): RetargetMapping {
  const sourceTable = freeJointTable(source);
  const entries: RetargetJointMap[] = [];
  for (const record of freeJointRecords(target)) {
    const counterpart = sourceTable.get(record.name);
    if (!counterpart || counterpart.node.type !== record.node.type) {
      throw new Error("目标可动关节集不是源的同名同型子集,缺关节档不适用;请改用 buildExplicitMapping 显式映射");
    }
    const ratio = record.node.type === "prismatic" ? suggestPrismaticRatio(source, target, record.name, record.name) : 1;
    entries.push({ sourceJoint: record.name, targetJoint: record.name, ratio });
  }
  return { tier: "partial-joints", entries };
}

/** 层级不同的显式映射:一对一校验(引用存在、类型一致、无重复),比例/偏移由调用方给定。 */
export function buildExplicitMapping(source: IKSkeleton, target: IKSkeleton, entries: readonly RetargetJointMap[]): RetargetMapping {
  const sourceTable = freeJointTable(source);
  const targetTable = freeJointTable(target);
  for (const entry of entries) {
    if (typeof entry.sourceJoint !== "string" || typeof entry.targetJoint !== "string") {
      throw new Error("映射条目必须提供 sourceJoint 与 targetJoint 名称");
    }
    requirePair(sourceTable, targetTable, entry);
    assertEntryValue(entry, "ratio");
    assertEntryValue(entry, "offset");
  }
  assertNoDuplicate(entries);
  return { tier: "explicit-mapping", entries: entries.map(entry => ({ ...entry })) };
}

interface PreparedMapping {
  /** 目标关节名 → 源关节名、比例、偏移(已展开缺省值)。 */
  entries: { sourceJoint: string; targetJoint: string; ratio: number; offset: number }[];
  sourceFree: FreeJointRecord[];
  targetFree: FreeJointRecord[];
}

function prepareMapping(source: IKSkeleton, target: IKSkeleton, mapping: RetargetMapping): PreparedMapping {
  if (!mapping || !Array.isArray(mapping.entries)) throw new Error("重定向映射无效");
  const sourceTable = freeJointTable(source);
  const targetTable = freeJointTable(target);
  for (const entry of mapping.entries) {
    requirePair(sourceTable, targetTable, entry);
    assertEntryValue(entry, "ratio");
    assertEntryValue(entry, "offset");
  }
  assertNoDuplicate(mapping.entries);
  const entries = mapping.entries.map(entry => ({
    sourceJoint: entry.sourceJoint,
    targetJoint: entry.targetJoint,
    ratio: entry.ratio ?? 1,
    offset: entry.offset ?? 0,
  }));
  return { entries, sourceFree: freeJointRecords(source), targetFree: freeJointRecords(target) };
}

function transferPose(prepared: PreparedMapping, sourcePose: Record<string, number>, sourceSkeleton: IKSkeleton, targetSkeleton: IKSkeleton): RetargetResult {
  // poseFromRecord 负责 plain-object/有限值/未知名/fixed/mimic 的显式报错。
  const validated = poseFromRecord(sourceSkeleton, sourcePose);
  const sourceValues: Record<string, number> = {};
  for (const record of prepared.sourceFree) sourceValues[record.name] = validated[record.index]!;
  const pose: Record<string, number> = {};
  for (const record of prepared.targetFree) pose[record.name] = 0;
  const transferred: string[] = [];
  const clamped: string[] = [];
  for (const entry of prepared.entries) {
    const raw = sourceValues[entry.sourceJoint]! * entry.ratio + entry.offset;
    const targetNode = targetSkeleton.nodes[jointIndexByName(targetSkeleton, entry.targetJoint)!]!;
    const clampedValue = targetNode.limits
      ? Math.min(targetNode.limits.upper, Math.max(targetNode.limits.lower, raw))
      : raw;
    if (!Number.isFinite(clampedValue)) throw new Error(`映射 ${entry.sourceJoint}→${entry.targetJoint} 迁移值无效`);
    pose[entry.targetJoint] = clampedValue;
    transferred.push(entry.targetJoint);
    if (clampedValue !== raw) clamped.push(entry.targetJoint);
  }
  const mappedSources = new Set(prepared.entries.map(entry => entry.sourceJoint));
  const dropped = prepared.sourceFree.filter(record => !mappedSources.has(record.name)).map(record => record.name);
  return { pose, transferred, dropped, clamped };
}

/** 单姿态重定向:映射先整体校验,再迁移、目标侧限位钳制,缺失源关节按 0 参与迁移。 */
export function retargetPose(source: IKSkeleton, target: IKSkeleton, mapping: RetargetMapping, sourcePose: Record<string, number>): RetargetResult {
  const prepared = prepareMapping(source, target, mapping);
  return transferPose(prepared, sourcePose, source, target);
}

/** 批量重定向:映射只校验一次,输入顺序在输出中原样保留。 */
export function retargetPoses(
  source: IKSkeleton,
  target: IKSkeleton,
  mapping: RetargetMapping,
  poses: readonly Record<string, number>[],
): RetargetResult[] {
  const prepared = prepareMapping(source, target, mapping);
  return poses.map(pose => transferPose(prepared, pose, source, target));
}
