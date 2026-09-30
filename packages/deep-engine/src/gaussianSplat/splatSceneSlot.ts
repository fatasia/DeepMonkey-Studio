/**
 * I 级 C1 3DGS——与 mesh 管线并存的场景 slot 合同(混合渲染骨架)。
 *
 * 定位:gaussian splat 是场景中一个**透明 slot**,排在全部不透明 mesh pass
 * 之后、后处理之前;深度测试开、深度写入关、back-to-front(CPU 排序序)。
 * 这与 T13 instanced(实例化 mesh,参与深度写入)与 HLOD(mesh 簇代理)语义
 * 正交:splat 不进 HLOD 簇、不吃 virtualTexture,是独立 storage-buffer 驻留。
 * 本模块只定合同与校验,不动 threeBridge/DeepWebGpuBackend(消费接线为后续刀)。
 */

export const SPLAT_RENDER_SLOT_KIND = "gaussian-splat" as const;
export type MeshOpaqueSlotKind = "mesh-opaque";
export type SceneSlotKind = MeshOpaqueSlotKind | typeof SPLAT_RENDER_SLOT_KIND;

export interface SceneSlot {
  kind: SceneSlotKind;
  /** 消费侧 pass 标识;仅要求同列表内唯一。 */
  id: string;
}

export interface SplatSlotBlendContract {
  /** straight alpha:片元输出 vec4(rgb·a, a),premultiplied mix。 */
  readonly colorBlend: "premultiplied-alpha";
  readonly depthCompare: "less";
  readonly depthWriteEnabled: false;
  /** 绘制顺序 = sortSplatsByDepth 输出(far→near)。 */
  readonly drawOrder: "far-to-near";
}

/** slot 混合合同(冻结值;消费侧不得覆盖,否则排序语义失效)。 */
export const SPLAT_SLOT_BLEND_CONTRACT: SplatSlotBlendContract = {
  colorBlend: "premultiplied-alpha",
  depthCompare: "less",
  depthWriteEnabled: false,
  drawOrder: "far-to-near",
} as const;

export interface SplatSceneSlotPlan {
  /** 全量有序 slot:mesh-opaque(输入序)在前,gaussian-splat 收尾。 */
  slots: readonly SceneSlot[];
  splatSlotIndex: number;
}

/**
 * 构造并存 slot 计划:splat 恒插在 mesh 不透明 pass 之后。
 * 空场景(0 mesh pass)也合法:plan 只含 splat slot。
 */
export function buildSplatSceneSlotPlan(meshOpaquePassIds: readonly string[]): SplatSceneSlotPlan {
  const slots: SceneSlot[] = meshOpaquePassIds.map((id) => ({ kind: "mesh-opaque", id }));
  slots.push({ kind: SPLAT_RENDER_SLOT_KIND, id: "deep-gaussian-splat-pass" });
  return { slots, splatSlotIndex: slots.length - 1 };
}

/** 共存校验:至多一个 splat slot 且必须在全部 mesh-opaque 之后(否则报错)。 */
export function validateSplatSceneSlotCoexistence(slots: readonly SceneSlot[]): void {
  const seenIds = new Set<string>();
  let splatSeen = false;
  for (const slot of slots) {
    if (seenIds.has(slot.id)) {
      throw new Error(`Scene slot id "${slot.id}" is duplicated; pass ids must be unique within a frame.`);
    }
    seenIds.add(slot.id);
    if (slot.kind === SPLAT_RENDER_SLOT_KIND) {
      if (splatSeen) {
        throw new Error("More than one gaussian-splat slot in one frame is not supported; splats render as a single sorted pass.");
      }
      splatSeen = true;
    } else if (splatSeen) {
      throw new Error(
        `Mesh-opaque slot "${slot.id}" appears after the gaussian-splat slot; ` +
        "splats must render last among opaque geometry so depth writes settle before alpha blending.");
    }
  }
}

/** 便捷断言:计划满足共存合同。 */
export function assertValidSplatSceneSlotPlan(plan: SplatSceneSlotPlan): void {
  validateSplatSceneSlotCoexistence(plan.slots);
}
