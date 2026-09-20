/**
 * 波次5 bindless 级 2:纹理数组打包索引合同的 TS 侧 golden 锁(跨端对拍一半)。
 * fixture 由 scripts/generateTextureArrayGolden.mts 从 webgpu/textureArrayPacking
 * 生成入库;本测试用同一 fixture 复核当前 TS 行为,Rust 侧
 * deep-engine-native::texture_array_packing_tests::matches_ts_golden_fixture
 * 读同一文件逐值比对——任一侧索引合同漂移都会使对拍失败(identityGolden)。
 * 本文件只 import webgpu 域,不改动其文件(另一会话域)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planTextureArrays } from "./webgpu/textureArrayPacking.js";

const GOLDEN_PATH = join(import.meta.dirname, "../fixtures/textureArrays/texture-array-golden.json");

interface GoldenScenario {
  readonly name: string;
  readonly input: { readonly maxArrayLayers: number; readonly entries: Parameters<typeof planTextureArrays>[0]["entries"] };
  readonly plan: {
    readonly arrays: readonly { readonly format: string; readonly width: number; readonly height: number;
      readonly arrayIndex: number; readonly layers: readonly string[] }[];
    readonly assignments: readonly { readonly textureId: string; readonly arrayIndex: number; readonly layerIndex: number }[];
    readonly overflowed: readonly string[];
  };
}

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { schema: string; scenarios: GoldenScenario[] };

describe("texture array packing cross-language golden (TS side of the Rust twin)", () => {
  it("still produces the committed plan for every scenario", () => {
    expect(golden.schema).toBe("deep-monkey.texture-array-golden.v1");
    expect(golden.scenarios.length).toBeGreaterThanOrEqual(4);
    for (const scenario of golden.scenarios) {
      const plan = planTextureArrays(scenario.input);
      expect(plan.arrays, `scenario '${scenario.name}' arrays`).toEqual(scenario.plan.arrays);
      expect([...plan.assignments.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([textureId, assignment]) =>
        ({ textureId, arrayIndex: assignment.arrayIndex, layerIndex: assignment.layerIndex })),
        `scenario '${scenario.name}' assignments`)
        .toEqual(scenario.plan.assignments);
      expect([...plan.overflowed], `scenario '${scenario.name}' overflowed`).toEqual(scenario.plan.overflowed);
    }
  });
});
