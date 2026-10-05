import type { Pipelines } from "./pipelines.js";

/** 缓存按 shadowPipelines.size 分键:首帧分级下 mask 变体 release 后补齐,size 单调
 * 增长,同 size 即同内容(track 只增不减),据此让补齐后的过滤视图正确重建。 */
const sets = new WeakMap<Pipelines, { readonly size: number; readonly value: Pipelines }>();
/** Selects unbiased rasterization without changing the default CSM or local shadow variants. */
export function authoredShadowPipelines(pipelines: Pipelines): Pipelines {
  const size = pipelines.shadowPipelines.size;
  const cached = sets.get(pipelines);
  if (cached && cached.size === size) return cached.value;
  const shadowPipelines = new Map([...pipelines.shadowPipelines]
    .filter(([key]) => key.startsWith("author/")).map(([key, value]) => [key.slice(7), value]));
  const shadow = shadowPipelines.get("solid/ccw");
  // 首帧分级(2026-10-06):authored solid ×3 raster 恒在 critical(作者阴影帧首帧验证
  // 必需,packetDraw 对 solid 缺失 fail-closed);mask 变体 release 后补齐,就绪前缺失
  // 交给 packetDraw 的 mask-skip(batch 级跳过阴影,变体就绪自动恢复)。solid 不全仍
  // fail-closed —— 那是管线集残缺(one-cascade 合同),不是分级态。
  if (!shadow || !shadowPipelines.has("solid/cw") || !shadowPipelines.has("solid/double")) {
    throw new Error("Authored shadow raster variants require a one-cascade renderer.");
  }
  const value = { ...pipelines, shadow, shadowPipelines };
  sets.set(pipelines, { size, value });
  return value;
}
