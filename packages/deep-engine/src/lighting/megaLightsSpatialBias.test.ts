// MegaLights 空间复用偏差二分回归资产(M2 定案 2026-10-04)。
// 四组复用配置对穷举精确参考的相对 RMSE 门(64 帧;确定性,seed 无关):
//   pure-RIS(temporal/spatial 全关)= 无 EMA 的单帧方差基线(15% 量级,只设恶化上界);
//   temporal 单开 = 颜色 EMA 在平均独立帧,~2% 量级(有效复用,不得回退);
//   spatial 单开 / 双开 = ≤5%(严格于验收①门 max(0.05, energy×5%))。
// 历史:旧式「邻居胜者单候选并入 + 全局 ÷m」把 resampled 胜者当均匀候选,系统性过亮
// (spatial 单开 22.9%、双开 15.6%);M2 改值域无偏平均后达标,见
// megaLightsRisCpu.spatialUnbiasedAverageCpu 注释。
import { describe, expect, it } from "vitest";
import { megaLightsExhaustiveReferenceCpu, megaLightsFrameCpu, rmse } from "./megaLightsRisCpu.js";

const W = 8, H = 8, PIXELS = W * H;
function scene(frame: number, count: number, moving: number) {
  const lights = Array.from({ length: count }, (_, index) => {
    const angle = index * 2.399963229728653;
    const radius = 2 + (index % 7) * 0.9;
    const isMoving = index < moving;
    const orbit = isMoving ? angle + frame * 0.04 : angle;
    return { kind: "point" as const,
      positionView: [Math.cos(orbit) * radius, Math.sin(orbit) * radius, 2 + (index % 3)],
      range: 0, color: [1, 0.95 - (index % 4) * 0.1, 0.9 - (index % 3) * 0.15],
      intensity: 0.6 + (index % 5) * 0.5, decay: 2 };
  });
  const surfaces = Array.from({ length: PIXELS }, (_, pixel) => {
    const x = pixel % W, y = Math.floor(pixel / W);
    return [[(x - (W - 1) / 2) * 0.4, (y - (H - 1) / 2) * 0.4, -3.5, 0], [0, 0, 1, 0.5], [0.8, 0.8, 0.8, 0]];
  });
  return { lights, surfaces };
}
function means(color: Float32Array) {
  const out: number[] = [];
  for (let p = 0; p < PIXELS; p++) out.push((color[p * 3]! + color[p * 3 + 1]! + color[p * 3 + 2]!) / 3);
  return out;
}

/** 单配置 64 帧链,后 16 帧逐帧相对 RMSE 的均值(%,确定性:场景静态、种子随帧递增)。
 * 口径说明:门语义是「空间复用不引入净偏差」→ 用期望质量(帧均值)。无 EMA 配置
 * (pure-ris/spatial)的单帧 RMSE 是重尾随机量(RIS 方差,80 帧实测 p90=6.2/max=8.0,
 * 均值 4.93),单帧抽检会把方差误判为偏差;EMA 配置后 16 帧已充分收敛,均值 = 稳态期望。 */
function convergedRelRmse(config: { temporal: boolean; spatial: boolean }): number {
  const sc = scene(7, 5000, 0);
  const reference = megaLightsExhaustiveReferenceCpu(sc.lights, sc.surfaces, W, H);
  const refMeans = means(reference);
  const energy = refMeans.reduce((a, b) => a + b, 0) / PIXELS;
  let previous: ReturnType<typeof megaLightsFrameCpu> | undefined;
  let output = previous;
  const tail: number[] = [];
  for (let frame = 0; frame < 64; frame++) {
    output = megaLightsFrameCpu({ lights: sc.lights, surfaces: sc.surfaces, frame,
      previous: previous?.reservoirs, previousColor: previous?.color,
      config: { width: W, height: H, ...config, alphaBlend: frame === 0 ? 1 : 1 / 32 } });
    previous = output;
    if (frame >= 48) tail.push(rmse(means(output!.color), refMeans) / energy * 100);
  }
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

describe("spatial reuse bias separation (M2 regression asset)", () => {
  it("four reuse configs hold their bias gates after the value-domain unbiased-average fix", () => {
    const results: Record<string, number> = {};
    for (const config of [
      { label: "pure-ris", temporal: false, spatial: false },
      { label: "temporal", temporal: true, spatial: false },
      { label: "spatial", temporal: false, spatial: true },
      { label: "both", temporal: true, spatial: true },
    ]) {
      const rel = convergedRelRmse(config);
      results[config.label] = rel;
      console.log(`config=${config.label} relRMSE(last16 mean)=${rel.toFixed(2)}%`);
    }
    // 门(实测定标 + 安全边距;超门即回归):
    expect(results["pure-ris"]!).toBeLessThanOrEqual(17); // 无 EMA 单帧方差基线(~15),只防恶化。
    expect(results["temporal"]!).toBeLessThanOrEqual(2.9); // 有效复用不得回退(本机基线实测 2.44)。
    expect(results["spatial"]!).toBeLessThanOrEqual(5); // 修复目标:严格于验收①门。
    expect(results["both"]!).toBeLessThanOrEqual(5); // 验收①默认路径的加强门。
  }, 120_000);
});
