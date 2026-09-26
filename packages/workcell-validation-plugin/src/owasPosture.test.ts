import { describe, expect, it } from "vitest";
import { classifyOwasPosture, formatOwasPosture, resolveOwasLoadCategory, OWAS_NOTE } from "./owasPosture.js";

const BACKS = [1, 2, 3, 4] as const;
const ARMS = [1, 2, 3] as const;
const LEGS = [1, 2, 3, 4, 5, 6, 7] as const;
const LOADS = [1, 2, 3] as const;

describe("OWAS posture classification (AC1-AC4)", () => {
  it("matches the documented anchor cells of the public digitized table", () => {
    // 良性基线:背直立、双臂低于肩、双腿伸直站立、≤10kg → AC1。
    expect(classifyOwasPosture({ back: 1, arm: 1, leg: 2, loadMassKg: 10 }).actionCategory).toBe(1);
    // 公开文献实例(wits.ac.za 学位论文):背扭转 3、单臂高 2、跪姿 6、<10kg → AC3。
    expect(classifyOwasPosture({ back: 3, arm: 2, leg: 6, loadMassKg: 5 }).actionCategory).toBe(3);
    // 教材共识最重姿态:背弯且扭 4、双臂高 3、双膝弯 4、>20kg → AC4。
    expect(classifyOwasPosture({ back: 4, arm: 3, leg: 4, loadMassKg: 25 }).actionCategory).toBe(4);
    // 弯背 2、双臂低于肩 1、坐姿 1、>20kg → AC3。
    expect(classifyOwasPosture({ back: 2, arm: 1, leg: 1, loadMassKg: 21 }).actionCategory).toBe(3);
  });

  it("classifies all 252 back x arm x leg x load combinations into AC1-AC4", () => {
    let combinations = 0;
    for (const back of BACKS) {
      for (const arm of ARMS) {
        for (const leg of LEGS) {
          for (const load of LOADS) {
            const loadMassKg = load === 1 ? 5 : load === 2 ? 15 : 25;
            const score = classifyOwasPosture({ back, arm, leg, loadMassKg });
            expect(score.actionCategory).toBeGreaterThanOrEqual(1);
            expect(score.actionCategory).toBeLessThanOrEqual(4);
            expect(score.code).toBe(`${back}${arm}${leg}${load}`);
            expect(score.actionLabel).toBeTruthy();
            combinations += 1;
          }
        }
      }
    }
    expect(combinations).toBe(252);
  });

  it("never lowers the action category when the load category increases (load monotonicity)", () => {
    for (const back of BACKS) {
      for (const arm of ARMS) {
        for (const leg of LEGS) {
          const categories = LOADS.map((load) => {
            const loadMassKg = load === 1 ? 2 : load === 2 ? 15 : 30;
            return classifyOwasPosture({ back, arm, leg, loadMassKg }).actionCategory;
          });
          expect(categories[0]!).toBeLessThanOrEqual(categories[1]!);
          expect(categories[1]!).toBeLessThanOrEqual(categories[2]!);
        }
      }
    }
  });

  it("maps load mass to categories with 10/20 kg boundaries and treats unknown loads as the worst group", () => {
    expect(resolveOwasLoadCategory(0)).toBe(1);
    expect(resolveOwasLoadCategory(10)).toBe(1);
    expect(resolveOwasLoadCategory(10.5)).toBe(2);
    expect(resolveOwasLoadCategory(20)).toBe(2);
    expect(resolveOwasLoadCategory(20.5)).toBe(3);
    expect(resolveOwasLoadCategory(undefined)).toBe(3);
    expect(() => resolveOwasLoadCategory(-1)).toThrow();
  });

  it("is deterministic and formats the posture for humans", () => {
    const posture = { back: 2, arm: 3, leg: 4, loadMassKg: 18 } as const;
    expect(classifyOwasPosture(posture)).toEqual(classifyOwasPosture(posture));
    expect(formatOwasPosture(posture)).toContain("双膝弯曲");
  });

  it("rejects invalid codes instead of clamping", () => {
    expect(() => classifyOwasPosture({ back: 5 as 4, arm: 1, leg: 1 })).toThrow();
    expect(() => classifyOwasPosture({ back: 1, arm: 0 as 1, leg: 1 })).toThrow();
    expect(() => classifyOwasPosture({ back: 1, arm: 1, leg: 8 as 7 })).toThrow();
    expect(() => classifyOwasPosture({ back: 1.5 as 1, arm: 1, leg: 1 })).toThrow();
  });

  it("carries the screening-only disclaimer", () => {
    expect(OWAS_NOTE).toContain("筛查参考");
    expect(classifyOwasPosture({ back: 1, arm: 1, leg: 2, loadMassKg: 5 }).note).toContain("筛查参考");
  });
});
