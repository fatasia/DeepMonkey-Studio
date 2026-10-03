// B2 MegaLights M1 ⑤ 退化对拍的黄金真值端(node 引擎计算,与 vitest 同源同值;
// runner 加载本模块算出穷举参考,浏览器只回传 GPU 数组,对比在 runner 完成——
// 规避浏览器内 CPU 参考链的求值偏差)。
import { megaLightsExhaustiveReferenceCpu } from "../src/lighting/megaLightsRisCpu.js";
import type { MegaLight } from "../src/lighting/megaLights.js";
import type { LightVector3 } from "../src/lighting/types.js";

export const PARITY_WIDTH = 16;
export const PARITY_HEIGHT = 16;

export function buildGoldenParityScene(): {
  readonly lights: readonly MegaLight[];
  readonly surfaces: Float32Array;
  readonly views: readonly (readonly (number | LightVector3)[])[];
} {
  const lights: MegaLight[] = Array.from({ length: 8 }, (_, index) => ({
    kind: index % 4 === 3 ? "spot" : "point",
    positionView: [Math.cos(index * 0.9) * 1.8, Math.sin(index * 1.1) * 1.8, 1.5 + (index % 3)] as unknown as LightVector3,
    range: index % 5 === 0 ? 0 : 9, color: [1, 0.9, 0.75], intensity: 0.8 + (index % 4) * 0.6, decay: 2,
    ...(index % 4 === 3 ? { directionView: [-Math.cos(index * 0.9), -Math.sin(index * 1.1), -1] as unknown as LightVector3,
      innerConeCos: 0.92, outerConeCos: 0.78 } : {}),
  }));
  const surfaces = new Float32Array(PARITY_WIDTH * PARITY_HEIGHT * 3 * 4);
  const views: (readonly (number | LightVector3)[])[] = [];
  for (let index = 0; index < PARITY_WIDTH * PARITY_HEIGHT; index++) {
    const x = index % PARITY_WIDTH, y = Math.floor(index / PARITY_WIDTH);
    surfaces[index * 12] = (x / PARITY_WIDTH - 0.5) * 3;
    surfaces[index * 12 + 1] = (0.5 - y / PARITY_HEIGHT) * 3;
    surfaces[index * 12 + 2] = -2.5;
    surfaces[index * 12 + 3] = 0;
    surfaces[index * 12 + 4] = 0; surfaces[index * 12 + 5] = 0; surfaces[index * 12 + 6] = 1;
    surfaces[index * 12 + 7] = 0.45;
    surfaces[index * 12 + 8] = 0.8; surfaces[index * 12 + 9] = 0.8; surfaces[index * 12 + 10] = 0.8;
    views.push([
      [surfaces[index * 12]!, surfaces[index * 12 + 1]!, surfaces[index * 12 + 2]!, surfaces[index * 12 + 3]!] as unknown as LightVector3,
      [surfaces[index * 12 + 4]!, surfaces[index * 12 + 5]!, surfaces[index * 12 + 6]!, surfaces[index * 12 + 7]!] as unknown as LightVector3,
      [surfaces[index * 12 + 8]!, surfaces[index * 12 + 9]!, surfaces[index * 12 + 10]!, surfaces[index * 12 + 11]!] as unknown as LightVector3,
    ]);
  }
  return { lights, surfaces, views };
}

export function computeGoldenParityColor(): { readonly rgb: number[]; readonly width: number; readonly height: number } {
  const { lights, surfaces } = buildGoldenParityScene();
  const color = megaLightsExhaustiveReferenceCpu(lights, surfacesViews(surfaces, PARITY_WIDTH, PARITY_HEIGHT), PARITY_WIDTH, PARITY_HEIGHT);
  return { rgb: [...color], width: PARITY_WIDTH, height: PARITY_HEIGHT };
}

function surfacesViews(surfaces: Float32Array, width: number, height: number): readonly (readonly (number | LightVector3)[])[] {
  const views: (readonly (number | LightVector3)[])[] = [];
  for (let index = 0; index < width * height; index++) {
    const base = index * 12;
    views.push([
      [surfaces[base]!, surfaces[base + 1]!, surfaces[base + 2]!, surfaces[base + 3]!] as unknown as LightVector3,
      [surfaces[base + 4]!, surfaces[base + 5]!, surfaces[base + 6]!, surfaces[base + 7]!] as unknown as LightVector3,
      [surfaces[base + 8]!, surfaces[base + 9]!, surfaces[base + 10]!, surfaces[base + 11]!] as unknown as LightVector3,
    ]);
  }
  return views;
}
