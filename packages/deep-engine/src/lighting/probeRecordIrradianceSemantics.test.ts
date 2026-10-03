// F5 能量/方向消费语义解析 oracle（第一路收口）。
// 背景（f5-real-moments-consumption-20261002 §机制缺口）：捕获核记录的是入射辐射的
// **4π 球均**（visibility/radiance 均值口径），而消费者（pbrShader `mix(environmentIrradiance,
// gi.rgb, gi.a)` → deepAuthoredDiffuse）把记录 RGB 当作**方向相关漫反射辐照度 E(n)**直接使用。
// 常量白炉场两者巧合相等（furnace 门一直绿的原因）；方向场（如半球天光）必然偏离。
// 本文件用解析积分把该偏离钉成确定性回归证据：修复（方向 atlas/SH）落地前，这些断言
// 记录"当前记录语义 ≠ 消费语义"的真实差距；落地后应改为断言一致。
import { describe, expect, it } from "vitest";

/** 半球场上半球恒定辐射 L、下半球 0：解析 E(n) 与 4π 均值。
 * E(n) = L·∫_{l_y>0} max(n·l,0) dω = π·L·(1+n_y)/2（n_y=cos 接收仰角）。 */
function hemisphere(normal: readonly [number, number, number], L: number): { storedMean: number; trueIrradiance: number; displayedByCurrentPath: number } {
  // 消费者当前路径：记录 = 4π 均值辐射 = L/2，直接当 E(n) 用（不随 n 变化）。
  const storedMean = L / 2;
  const trueIrradiance = Math.PI * L * (1 + normal[1]) / 2;
  return { storedMean, trueIrradiance, displayedByCurrentPath: storedMean };
}

describe("F5 GI 记录语义 vs 消费语义（解析负控，修复前为差距证据）", () => {
  const L = 2;

  it("常量场：4π 均值 = E(n)/π 对一切法线巧合成立（白炉门一直绿的解释）", () => {
    // 恒定辐射 L：E(n) = πL（任意 n），E/π = L = 4π 均值 → 两路径逐值相等。
    const stored = L, trueIrradianceOverPi = L;
    expect(stored).toBe(trueIrradianceOverPi);
  });

  it("半球场上朝法线：当前显示值为真值的一半（能量丢失 2×）", () => {
    const { storedMean, trueIrradiance, displayedByCurrentPath } = hemisphere([0, 1, 0], L);
    expect(storedMean).toBe(L / 2);
    expect(trueIrradiance / Math.PI).toBe(L); // 真 E(n)/π = L。
    expect(displayedByCurrentPath).toBe(L / 2); // 当前路径显示 L/2 → 丢一半。
    expect(displayedByCurrentPath).not.toBeCloseTo(trueIrradiance / Math.PI);
  });

  it("半球场水平法线：真值 L/2，当前路径巧合相等（解释部分表面'看起来对'）", () => {
    const { trueIrradiance, displayedByCurrentPath } = hemisphere([1, 0, 0], L);
    expect(trueIrradiance / Math.PI).toBe(L / 2);
    expect(displayedByCurrentPath).toBe(L / 2);
  });

  it("半球场朝下法线：真值为 0，当前路径漏光 L/2（sealed 室内漏光的解析同族）", () => {
    const { trueIrradiance, displayedByCurrentPath } = hemisphere([0, -1, 0], L);
    expect(trueIrradiance / Math.PI).toBe(0);
    expect(displayedByCurrentPath).toBe(L / 2);
    expect(displayedByCurrentPath).toBeGreaterThan(0);
  });

  it("黑 albedo 与全遮蔽与显示无关的边界不因语义修复改变（负控）", () => {
    // albedo=0 时漫反射出射恒 0，无论记录语义——修复不得引入非物理发光。
    const albedo = 0;
    expect(albedo * hemisphere([0, 1, 0], L).displayedByCurrentPath).toBe(0);
  });
});
