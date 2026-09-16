/** DE26/C01 · 能力清单合同 v1:逐对象失败码与频次的统一账本。
 *  可渲染与语义保留分列;错误必须能定位到资产字段;未知扩展不得静默丢弃。 */

export const CAPABILITY_INVENTORY_SCHEMA_VERSION = 1 as const;

export type CapabilityPath = "direct" | "bridge" | "native";
export type FailureStage = "decode" | "material" | "extension" | "geometry" | "animation" | "texture";

export interface CapabilityFailure {
  /** 机器失败码,如 "extension-unsupported" / "accessor-out-of-range"。 */
  readonly code: string;
  readonly stage: FailureStage;
  /** 资产内可定位字段路径,如 "materials[2].extensions.KHR_materials_clearcoat"。 */
  readonly assetPath: string;
  /** 人话原因;必须可操作,不许只写 "failed"。 */
  readonly detail: string;
  readonly count: number;
}

export interface CapabilityObjectEntry {
  readonly objectId: string;
  /** 本路径下对象是否进入渲染;不渲染的原因必须在 failures 里可定位。 */
  readonly renderable: boolean;
  /** 不可渲染时语义(变换/层级/属性)是否仍被保留登记。 */
  readonly semanticsPreserved: boolean;
  readonly failures: readonly CapabilityFailure[];
}

export interface CapabilityInventory {
  readonly schema: "deep-engine.capability-inventory";
  readonly schemaVersion: typeof CAPABILITY_INVENTORY_SCHEMA_VERSION;
  readonly assetId: string;
  readonly path: CapabilityPath;
  readonly objects: readonly CapabilityObjectEntry[];
}

export interface CapabilitySummary {
  readonly objects: number;
  readonly renderable: number;
  readonly semanticsOnly: number;
  readonly failed: number;
  /** 频次排序(降频)后的失败码账本;同码跨对象合并。 */
  readonly failuresByFrequency: readonly { readonly code: string; readonly stage: FailureStage; readonly count: number }[];
}

const CODE = /^[a-z0-9-]{3,64}$/;
const STAGES = new Set<FailureStage>(["decode", "material", "extension", "geometry", "animation", "texture"]);

/** 归并同对象同码失败;count 为正整数;校验语义一致性。 */
export function buildCapabilityInventory(inventory: CapabilityInventory): CapabilityInventory {
  if (inventory.schema !== "deep-engine.capability-inventory" || inventory.schemaVersion !== CAPABILITY_INVENTORY_SCHEMA_VERSION) {
    throw new Error("capability inventory schema identity mismatch");
  }
  if (!/^asset\./.test(inventory.assetId) || inventory.assetId.length > 128) throw new Error(`capability inventory assetId is invalid: ${inventory.assetId}`);
  if (!["direct", "bridge", "native"].includes(inventory.path)) throw new Error(`capability inventory path is invalid: ${String(inventory.path)}`);
  const seen = new Set<string>();
  for (const entry of inventory.objects) {
    if (seen.has(entry.objectId)) throw new Error(`duplicate capability object ${entry.objectId}`);
    seen.add(entry.objectId);
    if (!entry.objectId.trim()) throw new Error("capability object id is empty");
    if (!entry.renderable && !entry.failures.length) {
      throw new Error(`unrenderable object ${entry.objectId} must carry at least one locatable failure`);
    }
    if (entry.renderable && entry.failures.some(failure => failure.stage === "decode" && failure.count >= 1)) {
      throw new Error(`object ${entry.objectId} is renderable but carries decode failures`);
    }
    const codes = new Set<string>();
    for (const failure of entry.failures) {
      if (!CODE.test(failure.code)) throw new Error(`failure code is invalid: ${String(failure.code)}`);
      if (!STAGES.has(failure.stage)) throw new Error(`failure stage is invalid: ${String(failure.stage)}`);
      if (!failure.assetPath.trim()) throw new Error(`failure ${failure.code} must locate the asset field`);
      if (!failure.detail.trim()) throw new Error(`failure ${failure.code} must carry an actionable detail`);
      if (!Number.isSafeInteger(failure.count) || failure.count < 1) throw new Error(`failure ${failure.code} count must be a positive integer`);
      codes.add(failure.code);
    }
  }
  return inventory;
}

/** 频次汇总:频次降序、同频按码名字典序,保证同输入同输出。 */
export function summarizeCapabilityInventory(inventory: CapabilityInventory): CapabilitySummary {
  const totals = new Map<string, { code: string; stage: FailureStage; count: number }>();
  let renderable = 0, semanticsOnly = 0, failed = 0;
  for (const entry of inventory.objects) {
    if (entry.renderable) renderable += 1;
    else if (entry.semanticsPreserved) semanticsOnly += 1;
    else failed += 1;
    for (const failure of entry.failures) {
      const existing = totals.get(failure.code);
      if (existing) existing.count += failure.count;
      else totals.set(failure.code, { code: failure.code, stage: failure.stage, count: failure.count });
    }
  }
  return {
    objects: inventory.objects.length, renderable, semanticsOnly, failed,
    failuresByFrequency: [...totals.values()].sort((left, right) => right.count - left.count || (left.code < right.code ? -1 : 1)),
  };
}
