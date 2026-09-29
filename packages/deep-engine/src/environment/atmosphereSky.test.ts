import { describe, expect, it } from "vitest";
import { ATMOSPHERE_GRID } from "./atmosphereModel.js";
import {
  ATMOSPHERE_TABLES_FINGERPRINT, atmosphereGroundReflectedRadiance, atmosphereSkyEnvironmentImage,
  atmosphereSunTransmittance, atmosphereTables, evaluateAtmosphereSkyLuminance,
  sampleAtmosphereSkyRadiance,
} from "./atmosphereSky.js";

/** I-C6 运行时采样:表指纹/采样物理/图像确定性/三时段量化对照。 */

const NOON = { turbidity: 4, sunDirectionEnu: [0, 0.5, 0.8660254037844386] as const };

function sunAt(elevationDeg: number, azimuthDeg = 0): readonly [number, number, number] {
  const elevation = elevationDeg * Math.PI / 180, azimuth = azimuthDeg * Math.PI / 180;
  return [Math.cos(elevation) * Math.sin(azimuth), Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation)] as const;
}

describe("I-C6 预计算表完整性", () => {
  it("三表 sha256 逐表自钉;指纹为管道串联(手改即红)", () => {
    const tables = atmosphereTables(); // 解码即校验,失配抛错
    expect(tables.transmittance.length).toBe(64 * 3);
    expect(tables.single.length).toBe(6 * ATMOSPHERE_GRID.singleViewCount * ATMOSPHERE_GRID.singleSunCount
      * ATMOSPHERE_GRID.singleGammaCount);
    expect(tables.multiple.length).toBe(4 * ATMOSPHERE_GRID.multipleViewCount * ATMOSPHERE_GRID.multipleSunCount);
    expect(ATMOSPHERE_TABLES_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/);
  });

  it("表解码是缓存单例:两次调用同实例(无重复解码)", () => {
    expect(atmosphereTables()).toBe(atmosphereTables());
  });
});

describe("I-C6 采样物理", () => {
  it("太阳方向不在天空场中(无日盘):天顶采样有限且非零", () => {
    const out = new Float32Array(3);
    evaluateAtmosphereSkyLuminance(NOON, 1, 1, out);
    for (const value of out) expect(Number.isFinite(value)).toBe(true);
    expect(out[1]!).toBeGreaterThan(0);
  });

  it("日间天空蓝移:天顶 B 通道 > R 通道(Rayleigh 1/λ⁴)", () => {
    const out = new Float32Array(3);
    evaluateAtmosphereSkyLuminance(NOON, 1, 0.2, out);
    expect(out[2]!).toBeGreaterThan(out[0]!);
  });

  it("太阳越低整体越暗(透射路径变长):午 > 晨 > 暮(天顶亮度单调)", () => {
    const zenith = (elevation: number): number => {
      const out = new Float32Array(3);
      evaluateAtmosphereSkyLuminance({ turbidity: 4, sunDirectionEnu: sunAt(elevation) }, 1, 0.5, out);
      return out[0]! + out[1]! + out[2]!;
    };
    expect(zenith(60)).toBeGreaterThan(zenith(15));
    expect(zenith(15)).toBeGreaterThan(zenith(5));
  });

  it("暮色红移:太阳低角度时地平方向 R/B 比显著高于正午(长路径 Rayleigh)", () => {
    const redBlue = (elevation: number): number => {
      const out = new Float32Array(3);
      const viewMu = 0.08, sun = sunAt(elevation);
      const cosGamma = viewMu * sun[2]! + Math.sqrt(1 - viewMu * viewMu) * Math.sqrt(1 - sun[2]! ** 2);
      evaluateAtmosphereSkyLuminance({ turbidity: 4, sunDirectionEnu: sun }, viewMu, cosGamma, out);
      return out[0]! / Math.max(out[2]!, 1e-9);
    };
    expect(redBlue(3)).toBeGreaterThan(redBlue(60) * 1.2);
  });

  it("浊度缩放只作用于 Mie 分量:浊度增大天空变亮变灰(白化)", () => {
    const sample = (turbidity: number): Float32Array => {
      const out = new Float32Array(3);
      evaluateAtmosphereSkyLuminance({ turbidity, sunDirectionEnu: sunAt(60) }, 0.6, 0.9, out);
      return out;
    };
    const clear = sample(2), hazy = sample(9);
    expect(hazy[1]!).toBeGreaterThan(clear[1]!);
    expect(hazy[2]! / hazy[0]!).toBeLessThan(clear[2]! / clear[0]!); // 色度白化
  });

  it("非法参数 fail-fast:turbidity 越界与非单位太阳矢量抛 RangeError", () => {
    expect(() => evaluateAtmosphereSkyLuminance(
      { turbidity: 1, sunDirectionEnu: sunAt(45) }, 1, 0, new Float32Array(3))).toThrow(RangeError);
    expect(() => evaluateAtmosphereSkyLuminance(
      { turbidity: 4, sunDirectionEnu: [1, 1, 1] }, 1, 0, new Float32Array(3))).toThrow(RangeError);
  });

  it("下半球 = Lambert 地面反射:亮度非负且低于上半球天顶", () => {
    const ground = atmosphereGroundReflectedRadiance(NOON);
    const out = new Float32Array(3);
    evaluateAtmosphereSkyLuminance(NOON, 1, 0.2, out);
    for (const value of ground) expect(Number.isFinite(value)).toBe(true);
    expect(ground[1]!).toBeLessThan(out[1]!);
    expect(sampleAtmosphereSkyRadiance(NOON, [0, 0, -1])[1]).toBe(ground[1]); // 正下方走地面分支
  });
});

describe("I-C6 equirect 环境图", () => {
  it("确定性:同参数两次生成逐位相同,且缓存命中同实例", () => {
    const a = atmosphereSkyEnvironmentImage(NOON, 64, 32);
    const b = atmosphereSkyEnvironmentImage(NOON, 64, 32);
    expect(b).toBe(a);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("合同形状:第 0 行 = 天顶(亮度 ≥ 地平行),尺寸与声明一致", () => {
    const image = atmosphereSkyEnvironmentImage(NOON, 32, 16);
    expect(image.width).toBe(32);
    expect(image.height).toBe(16);
    expect(image.data.length).toBe(32 * 16 * 3);
    const rowLuma = (row: number): number => {
      let sum = 0;
      for (let column = 0; column < 32; column += 1) {
        sum += image.data[(row * 32 + column) * 3 + 1]!;
      }
      return sum;
    };
    expect(rowLuma(1)).toBeGreaterThan(rowLuma(14)); // 上半球亮于下半球(地面反射)
  });

  it("三时段图像量化对照:晨/午/暮亮度与色度方向正确(报告引用值)", () => {
    const stats = (elevation: number): { luma: number; redBlue: number } => {
      const image = atmosphereSkyEnvironmentImage({ turbidity: 4, sunDirectionEnu: sunAt(elevation) }, 64, 32);
      let luma = 0, red = 0, blue = 0;
      for (let index = 0; index < 64 * 16; index += 1) { // 只统计上半球
        const offset = index * 3;
        luma += image.data[offset]! + image.data[offset + 1]! + image.data[offset + 2]!;
        red += image.data[offset]!; blue += image.data[offset + 2]!;
      }
      return { luma: luma / (64 * 16), redBlue: red / Math.max(blue, 1e-9) };
    };
    const noon = stats(60), morning = stats(15), dusk = stats(5);
    expect(noon.luma).toBeGreaterThan(morning.luma);
    expect(morning.luma).toBeGreaterThan(dusk.luma);
    expect(dusk.redBlue).toBeGreaterThan(noon.redBlue); // 暮色红移
  });

  it("非法尺寸抛 RangeError", () => {
    expect(() => atmosphereSkyEnvironmentImage(NOON, 4, 4)).toThrow(RangeError);
  });
});

describe("I-C6 太阳透射表", () => {
  it("地平下熄灭、地平上单调;蓝通道透射低于红通道", () => {
    const at = (elevation: number): readonly [number, number, number] =>
      atmosphereSunTransmittance({ turbidity: 4, sunDirectionEnu: sunAt(elevation) });
    expect(at(-10)[1]).toBe(0);
    expect(at(5)[1]).toBeGreaterThan(0);
    expect(at(45)[1]).toBeGreaterThan(at(5)[1]);
    expect(at(45)[2]).toBeLessThan(at(45)[0]);
  });
});
