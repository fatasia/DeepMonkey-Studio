/**
 * 生成纹理数组打包的跨端 golden fixture:固定输入 → planTextureArrays 的
 * (arrays / assignments / overflowed)。Rust 侧
 * deep-engine-native::texture_array_packing_tests::matches_ts_golden_fixture 与
 * TS 侧 src/textureArrayGoldenContract.test.ts 读取同一 fixture 逐值比对
 * (identityGolden 模式,同 generateBvhGolden.mts 先例):任何一侧索引合同漂移
 * 都会使对拍失败。重新运行本脚本即可让 TS 行为变化显式落在 git diff 里。
 * 运行:仓库根 `node_modules/.bin/tsx packages/deep-engine/scripts/generateTextureArrayGolden.mts`
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { planTextureArrays } from "../src/webgpu/textureArrayPacking.js";

const entry = (textureId: string, format = "rgba8unorm", width = 512, height = 512) =>
  ({ textureId, format, width, height });

/** 固定输入覆盖合同四个面:分箱+字典序、溢出回退、跨箱同名覆盖、多箱溢出顺序。 */
const scenarios = [
  {
    name: "mixed-formats-and-sizes",
    maxArrayLayers: 8,
    entries: [
      entry("t-c"), entry("t-a", "rgba16float"), entry("t-b"), entry("t-half", "rgba8unorm", 256, 256),
    ],
  },
  {
    name: "overflow-into-fallback",
    maxArrayLayers: 2,
    entries: [entry("a"), entry("b"), entry("c")],
  },
  {
    name: "duplicate-id-across-boxes",
    maxArrayLayers: 4,
    entries: [entry("shared"), entry("shared", "rgba16float")],
  },
  {
    name: "multi-box-overflow-ordering",
    maxArrayLayers: 2,
    entries: [
      entry("w-3"), entry("w-1"), entry("w-4"), entry("w-2"),
      entry("n-1", "rgba16float"), entry("n-2", "rgba16float"), entry("n-3", "rgba16float"),
      entry("s-1", "rgba8unorm", 256, 256),
    ],
  },
];

const fixture = {
  schema: "deep-monkey.texture-array-golden.v1",
  scenarios: scenarios.map(({ name, maxArrayLayers, entries }) => {
    const plan = planTextureArrays({ entries, maxArrayLayers });
    return {
      name,
      input: { maxArrayLayers, entries },
      plan: {
        arrays: plan.arrays.map(array => ({
          format: array.format, width: array.width, height: array.height,
          arrayIndex: array.arrayIndex, layers: [...array.layers],
        })),
        // 按纹理 id 字典序序列化,跨端比对不依赖 Map 迭代序。
        assignments: [...plan.assignments.entries()]
          .sort(([left], [right]) => left < right ? -1 : 1)
          .map(([textureId, assignment]) => ({
            textureId, arrayIndex: assignment.arrayIndex, layerIndex: assignment.layerIndex,
          })),
        overflowed: [...plan.overflowed],
      },
    };
  }),
};

const outDir = resolve(import.meta.dirname ?? ".", "../fixtures/textureArrays");
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, "texture-array-golden.json");
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
const totals = fixture.scenarios.map(scenario =>
  `${scenario.name}: ${scenario.plan.arrays.length} arrays, `
  + `${scenario.plan.assignments.length} assigned, ${scenario.plan.overflowed.length} overflowed`);
console.log(`wrote ${out}\n  ${totals.join("\n  ")}`);
