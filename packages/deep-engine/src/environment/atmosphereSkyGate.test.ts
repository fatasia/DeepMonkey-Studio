import { describe, expect, it } from "vitest";
import { atmosphereSkyPresetForQuality, resolveAtmosphereSkyMode } from "./atmosphereSkyGate.js";

/** I-C6 opt-in 门:默认关(fail-closed 语义)+ 质量档映射。 */

describe("I-C6 天空模式解析(fail-closed)", () => {
  it("默认关:undefined 与 \"neutral\" 都返回 neutral,无 failClosed", () => {
    for (const value of [undefined, "neutral"] as const) {
      const resolution = resolveAtmosphereSkyMode(value);
      expect(resolution.mode).toBe("neutral");
      expect(resolution.failClosed).toBe(false);
      expect(resolution.parameters).toBeUndefined();
    }
  });

  it("显式 \"atmosphere\" → atmosphere + 默认参数(正午太阳/浊度 4)", () => {
    const resolution = resolveAtmosphereSkyMode("atmosphere");
    expect(resolution.mode).toBe("atmosphere");
    expect(resolution.failClosed).toBe(false);
    expect(resolution.parameters?.turbidity).toBe(4);
    expect(resolution.parameters?.sunDirectionEnu).toEqual([0, 0.5, 0.8660254037844386]);
  });

  it("合法 config:逐字段透传,无 failClosed", () => {
    const resolution = resolveAtmosphereSkyMode({
      turbidity: 6, sunDirectionEnu: [0, 0.7, 0.714142842854285], mieAnisotropy: 0.7, groundAlbedo: 0.2,
    });
    expect(resolution.mode).toBe("atmosphere");
    expect(resolution.failClosed).toBe(false);
    expect(resolution.parameters?.turbidity).toBe(6);
    expect(resolution.parameters?.mieAnisotropy).toBe(0.7);
    expect(resolution.parameters?.groundAlbedo).toBe(0.2);
  });

  it("非法标量 fail-closed 回 neutral 并给机器可读原因(渲染循环不中断)", () => {
    for (const value of [42, "ultra", true] as unknown[]) {
      const resolution = resolveAtmosphereSkyMode(value as never);
      expect(resolution.mode).toBe("neutral");
      expect(resolution.failClosed).toBe(true);
      expect(resolution.reason).toContain("failed closed to neutral");
    }
  });

  it("config 越界字段逐项钳制并记录 reason(模式不回退,只修字段)", () => {
    const resolution = resolveAtmosphereSkyMode({
      turbidity: 99, sunDirectionEnu: [1, 1, 1], mieAnisotropy: 7, groundAlbedo: -3,
    });
    expect(resolution.mode).toBe("atmosphere");
    expect(resolution.failClosed).toBe(true);
    expect(resolution.parameters?.turbidity).toBe(4);
    expect(resolution.parameters?.sunDirectionEnu).toEqual([0, 0.5, 0.8660254037844386]);
    expect(resolution.parameters?.mieAnisotropy).toBe(0.99);
    expect(resolution.parameters?.groundAlbedo).toBe(0);
    expect(resolution.reason).toContain("turbidity");
    expect(resolution.reason).toContain("sunDirectionEnu");
  });
});

describe("I-C6 质量档映射(fail-fast)", () => {
  it("performance/balanced → neutral(默认);quality → atmosphere(opt-in)", () => {
    expect(atmosphereSkyPresetForQuality("performance")).toBe("neutral");
    expect(atmosphereSkyPresetForQuality("balanced")).toBe("neutral");
    expect(atmosphereSkyPresetForQuality("quality")).toBe("atmosphere");
  });

  it("非法档 fail-fast 抛 RangeError(作者期错误在接线处暴露)", () => {
    expect(() => atmosphereSkyPresetForQuality("ultra" as never)).toThrow(RangeError);
  });
});
