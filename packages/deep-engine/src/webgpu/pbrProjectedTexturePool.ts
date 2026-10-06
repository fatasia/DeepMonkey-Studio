import { resolveProjectedTextureFrame, PROJECTED_TEXTURE_MAX_PROJECTORS,
} from "../postprocess/projectedTextureCpu.js";
import type { ProjectedTextureFrame, ProjectedTextureLight } from "../postprocess/projectedTextureTypes.js";

/**
 * P2 投影纹理光多投影器灯池解析(自 pbrRendererFrames 提取,守 800 行体量门)。
 * 渲染循环每帧把 RenderView 供给的投影器灯池(≤4,2026-10-06 后继切片)逐灯解析成
 * 视空间帧:单灯校验失败仅剔除该灯(reasons 如实带首条原因),不炸帧;整池超员
 * fail-closed 上抛(交调用方整帧披露)。单投影器字段 = 池 count 1 退化路径。
 */

export interface PbrProjectedTexturePoolResolution {
  /** 可用投影器帧(槽序 = 累加序;0 = 该帧无投影器贡献)。 */
  readonly frames: readonly ProjectedTextureFrame[];
  /** fail-closed 披露:被剔除灯数与首条原因,或空池;全池有效 = undefined。 */
  readonly fallbackReason?: string;
}

export function resolveProjectedTexturePool(lights: readonly ProjectedTextureLight[],
  worldToView: ArrayLike<number>): PbrProjectedTexturePoolResolution {
  if (lights.length > PROJECTED_TEXTURE_MAX_PROJECTORS) {
    throw new RangeError(`projectedTextureLights pool exceeds ${PROJECTED_TEXTURE_MAX_PROJECTORS} projectors (${lights.length}).`);
  }
  const frames: ProjectedTextureFrame[] = [];
  const reasons: string[] = [];
  for (const light of lights) {
    try {
      frames.push(resolveProjectedTextureFrame(light, worldToView));
    } catch (error) {
      reasons.push((error as Error).message);
    }
  }
  if (reasons.length > 0) {
    return { frames,
      fallbackReason: `${reasons.length} invalid projector(s) dropped from pool: ${reasons[0]!}` };
  }
  if (frames.length === 0) return { frames, fallbackReason: "empty projector pool" };
  return { frames };
}
