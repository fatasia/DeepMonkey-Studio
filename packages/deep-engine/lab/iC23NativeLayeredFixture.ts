/** I-C23 Native 刀 · 双端对拍 fixture 生成器(TS 权威端)。
 * 用已验 Web 单源(packLayeredSurfaceBlock + 混合闭式镜像)产出:
 * - 304B 块金标(Rust pack_layered_surface_block 逐位对拍);
 * - 求值响应级混合闭式案例(与 materialLayeredEvaluate.blendChannel 同运算序);
 * - 白炉凸性案例(双端 GPU 白炉轮的 CPU 先验)。
 * 本文件只被 scripts/i-c23-native-layered-fixture.mjs 打包运行;持久化产物是
 * packages/deep-engine/fixtures/i-c23-native-layered-block-v1.json。 */

import { packLayeredSurfaceBlock, normalizeLayeredSurfaceParameters,
  type LayeredSurfaceParameters } from "../src/shader/materialLayeredSurface.js";
import type { LayeredSurfaceTextureBinding } from "../src/shader/materialLayeredSurface.js";
import type { PreparedTextureSlot, TextureSlot } from "../src/renderPacketTypes.js";

/** 与 renderPacketMaterials.prepareSlot 同式:仿射两行 + fround + -0 归一。 */
function uvTransform(slot: Pick<TextureSlot, "offset" | "scale" | "rotation">): [number, number, number, number, number, number] {
  const [tx, ty] = slot.offset ?? [0, 0], [sx, sy] = slot.scale ?? [1, 1];
  const rotation = slot.rotation ?? 0;
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return [c * sx, -s * sy, tx, s * sx, c * sy, ty].map(value => {
    const result = Math.fround(value);
    return Object.is(result, -0) ? 0 : result;
  }) as [number, number, number, number, number, number];
}

function preparedSlot(slot: TextureSlot): PreparedTextureSlot {
  return { texture: slot.texture, texCoord: slot.texCoord ?? 0, uvTransform: uvTransform(slot) };
}

export interface IC23LayerBlendCase {
  readonly underlying: readonly [number, number, number];
  readonly layer: readonly [number, number, number];
  readonly coverage: number;
  readonly overlay: boolean;
  readonly expected: readonly [number, number, number];
}

export interface IC23NativeLayeredFixture {
  readonly abi: "deep.pbr.layered-surface.v1";
  readonly blockBytes: 304;
  /** 权威端规范输入(TS normalizeLayeredSurfaceParameters 的输入形态)。 */
  readonly material: unknown;
  /** TS packLayeredSurfaceBlock 的 76-f32 输出(Rust 逐位对拍)。 */
  readonly block: readonly number[];
  /** 求值响应级混合闭式案例(运算序 = materialLayeredEvaluate 镜像)。 */
  readonly blendCases: readonly IC23LayerBlendCase[];
  /** 白炉凸性:双亲 ≤1 时混合 ≤1(闭式恒真,GPU 轮先验)。 */
  readonly furnace: {
    readonly base: readonly [number, number, number];
    readonly layers: readonly { readonly rgb: readonly [number, number, number];
      readonly coverage: number; readonly overlay: boolean }[];
    readonly blended: readonly [number, number, number];
    readonly bound: 1;
  };
}

function blendCase(underlying: readonly [number, number, number],
  layer: readonly [number, number, number], coverage: number, overlay: boolean): IC23LayerBlendCase {
  // 与 materialLayeredEvaluate.layerWeights/blendVec3 同序:先 w,后乘加。
  const weights = overlay
    ? layer.map(value => coverage * Math.min(1, Math.max(0, value))) as [number, number, number]
    : [coverage, coverage, coverage] as [number, number, number];
  const expected = [0, 1, 2].map(channel =>
    (1 - weights[channel]!) * underlying[channel]! + weights[channel]! * layer[channel]!) as [number, number, number];
  return { underlying, layer, coverage, overlay, expected };
}

/** 规范层栈:层 0 overlay+双纹理(UV1/缩放),层 1 replace 纯色。 */
export const IC23_NATIVE_LAYERED_INPUT = {
  layers: [
    {
      coverage: 0.75, mode: "overlay" as const,
      surface: {
        baseColor: [0.8, 0.2, 0.1] as [number, number, number], metallic: 0.25, roughness: 0.5,
        baseColorTexture: { texture: "layer-base", texCoord: 1 as const,
          offset: [0.25, 0] as [number, number], scale: [1, 1] as [number, number], rotation: 0 },
        metallicRoughnessTexture: { texture: "layer-mr", texCoord: 0 as const,
          offset: [0, 0] as [number, number], scale: [2, 2] as [number, number], rotation: 0 },
      },
    },
    {
      coverage: 0.5, mode: "replace" as const,
      surface: { baseColor: [0.1, 0.9, 0.4] as [number, number, number] },
    },
  ],
};

export function buildIC23NativeLayeredFixture(): IC23NativeLayeredFixture {
  const parameters: LayeredSurfaceParameters = normalizeLayeredSurfaceParameters(IC23_NATIVE_LAYERED_INPUT);
  // 规范化后按层表面在独立 surfaces 数组(与 layers 等长同序),纹理槽从那里取。
  const bindings: LayeredSurfaceTextureBinding[] = parameters.layers.map((layer, index) => {
    const surface = parameters.surfaces[index];
    return {
      ...(surface?.baseColorTexture
        ? { baseColor: { slot: preparedSlot(surface.baseColorTexture), arrayLayer: 0 } } : {}),
      ...(surface?.metallicRoughnessTexture
        ? { metallicRoughness: { slot: preparedSlot(surface.metallicRoughnessTexture), arrayLayer: 0 } } : {}),
    };
  });
  const block = Array.from(packLayeredSurfaceBlock(parameters, bindings));
  return {
    abi: "deep.pbr.layered-surface.v1",
    blockBytes: 304,
    material: IC23_NATIVE_LAYERED_INPUT,
    block,
    blendCases: [
      blendCase([1, 0.5, 0], [0, 0.25, 1], 0.75, false),
      blendCase([1, 1, 1], [0.02, 0, 0.5], 1, true),
      blendCase([1, 0.5, 0], [2, 1, 4], 0.5, true),
      blendCase([0.5, 0.5, 0.5], [0, 0, 0], 0.5, false),
      blendCase([0.3, 0.6, 0.9], [1, 1, 1], 0, true),
    ],
    furnace: (() => {
      const layers = [
        { rgb: [1, 0.4, 0.2] as [number, number, number], coverage: 0.75, overlay: true },
        { rgb: [0.6, 0.9, 0.3] as [number, number, number], coverage: 0.5, overlay: false },
      ];
      const base: [number, number, number] = [0.9, 0.9, 0.9];
      let blended: [number, number, number] = base;
      for (const layer of layers) {
        blended = [...blendCase(blended, layer.rgb, layer.coverage, layer.overlay).expected] as [number, number, number];
      }
      return { base, layers, blended, bound: 1 };
    })(),
  };
}
