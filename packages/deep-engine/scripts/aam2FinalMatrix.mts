// AA-M2 终表生成器(两口径 × 全档能量矩阵):
// 口径 A = 欠采样极限(syntheticStaircaseCase / aaComboSample,门①根因实证口径,
//          3px 周期细栅栏 + 1px 圆弧在采样定理下不可恢复,度量 AA 的下界诚实性);
// 口径 B = 可采样(resolvableStaircaseCase / resolvableComboSample,2026-10-04
//          口径修正:斜边/粗栅栏/粗圆弧全部满足采样定理,门①判定口径)。
// 解析档(MSAA4/a2c/TSR)由 aaComboHarness 骨架出数;SMAA/FXAA 走 CPU 权威镜像
// (8bit 量化输入,与 GPU 探针同口径);GPU SMAA 数字从探针 evidence.json 合并。
// 运行:npx tsx packages/deep-engine/scripts/aam2FinalMatrix.mts
// 证据:test-output/deep-core/AAM2/final-matrix.json
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { measureAliasingEnergy, aliasingReduction, resolvableStaircaseCase, syntheticStaircaseCase,
  type StaircaseScenario } from "../src/postprocess/aliasingEnergy.js";
import { resolveSmaaCpu } from "../src/postprocess/smaaCpu.js";
import { resolveSpatialAaCpu } from "../src/postprocess/spatialAaCpu.js";
import { aaComboEnergyTable, resolvableComboEnergyTable, renderBinaryCoverageMsaa4,
  renderBinaryCoverageMsaa4Tsr, renderAaComboMsaa4Tsr, renderResolvableComboMsaa4Tsr,
  aaComboReferenceFor, aaComboSample, resolvableComboSample,
  type AaComboEnergyTable, type AaComboSampleFn } from "../src/postprocess/aaComboHarness.js";

const outputDir = fileURLToPath(new URL("../../../test-output/deep-core/AAM2/", import.meta.url));
const round = (value: number): number => Number(value.toFixed(4));
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** 8bit 量化往返(present 合同 rgba8unorm 口径,SMAA/FXAA 输入与 GPU 链一致)。 */
function quantize8(image: Float32Array): Float32Array {
  const out = new Float32Array(image.length);
  for (let i = 0; i < image.length; i++) out[i] = Math.round(Math.max(0, Math.min(1, image[i]!)) * 255) / 255;
  return out;
}

interface MatrixRow { readonly tier: string; readonly edgeEnergy: number; readonly reduction: string }
interface FamilyTable {
  readonly family: string;
  readonly caliber: "undersampled-limit" | "resolvable";
  readonly width: number;
  readonly height: number;
  readonly rows: readonly MatrixRow[];
}

/** 阶梯家族(smaaGpuAcceptanceProbe 同场景):noAA/FXAA/SMAA/MSAA4/TSR/组合档→SMAA。 */
function staircaseFamilyTable(name: "synthetic" | "resolvable", width = 256, height = 256): FamilyTable {
  const scene: StaircaseScenario = name === "synthetic"
    ? syntheticStaircaseCase(width, height) : resolvableStaircaseCase(width, height);
  const measure = (output: ArrayLike<number>) => measureAliasingEnergy({ output, reference: scene.reference,
    width, height, sourceContrast: scene.sourceContrast });
  const baseline = measure(scene.noAA);
  const quantized = quantize8(scene.noAA);
  const smaa = resolveSmaaCpu({ width, height, color: quantized });
  const fxaa = resolveSpatialAaCpu({ width, height, color: quantized });
  const msaa4 = renderBinaryCoverageMsaa4(width, height, scene.coverAt);
  const msaa4Smaa = resolveSmaaCpu({ width, height, color: quantize8(msaa4) });
  const tsr = renderBinaryCoverageMsaa4Tsr(width, height, scene.coverAt, 16);
  const tsrSmaa = resolveSmaaCpu({ width, height, color: quantize8(tsr) });
  const rows = [
    { tier: "noAA(baseline)", energy: baseline },
    { tier: "fxaa(cpu-mirror,8bit)", energy: measure(fxaa) },
    { tier: "smaa(cpu-mirror,8bit)", energy: measure(smaa) },
    { tier: "msaa4(analytic)", energy: measure(msaa4) },
    { tier: "msaa4→smaa(hw-combo,8bit)", energy: measure(msaa4Smaa) },
    { tier: "msaa4+tsr(analytic,16f)", energy: measure(tsr) },
    { tier: "msaa4+tsr→smaa(combo,8bit)", energy: measure(tsrSmaa) },
  ] as const;
  return {
    family: name === "synthetic" ? "syntheticStaircaseCase" : "resolvableStaircaseCase",
    caliber: name === "synthetic" ? "undersampled-limit" : "resolvable",
    width, height,
    rows: rows.map(({ tier, energy }) => ({ tier, edgeEnergy: round(energy.edgeEnergy),
      reduction: pct(aliasingReduction(baseline.edgeEnergy, energy.edgeEnergy)) })),
  };
}

/** 组合家族全档(harness 能量表)+ 组合档→SMAA 叠加判定行(同场景同尺)。 */
function comboFamilyTable(name: "undersampled-limit" | "resolvable", width = 192, height = 128): FamilyTable {
  const resolvable = name === "resolvable";
  const table: AaComboEnergyTable = resolvable
    ? resolvableComboEnergyTable(width, height) : aaComboEnergyTable(width, height);
  const sampleFn: AaComboSampleFn = resolvable ? resolvableComboSample : aaComboSample;
  const reference = aaComboReferenceFor(width, height, sampleFn);
  const measure = (output: Float32Array) => measureAliasingEnergy({ output, reference, width, height,
    sourceContrast: table.sourceContrast });
  const baselineEdge = table.rows[0]!.energy.edgeEnergy;
  // 组合档(msaa4+a2c+tsr 16 帧解析)→ SMAA:空间后处理合法叠加,判"SMAA 在其上再降"。
  const comboOutput = resolvable
    ? renderResolvableComboMsaa4Tsr(width, height, 16, true)
    : renderAaComboMsaa4Tsr(width, height, 16, true);
  const comboSmaa = resolveSmaaCpu({ width, height, color: quantize8(comboOutput) });
  const comboSmaaEnergy = measure(comboSmaa);
  const comboSmaaReduction = aliasingReduction(baselineEdge, comboSmaaEnergy.edgeEnergy);
  const comboRow = table.rows[table.rows.length - 1]!;
  return {
    family: resolvable ? "resolvableComboSample" : "aaComboSample",
    caliber: name,
    width, height,
    rows: [
      ...table.rows.map(row => ({ tier: row.tier, edgeEnergy: round(row.energy.edgeEnergy),
        reduction: pct(row.reduction) })),
      { tier: "msaa4+a2c+tsr→smaa(combo,8bit)", edgeEnergy: round(comboSmaaEnergy.edgeEnergy),
        reduction: pct(comboSmaaReduction) },
    ],
  };
}

const verdictInput = {
  staircases: [staircaseFamilyTable("synthetic"), staircaseFamilyTable("resolvable")],
  combos: [comboFamilyTable("undersampled-limit"), comboFamilyTable("resolvable")],
};
const undersampledStaircase = verdictInput.staircases[0]!;
const resolvableStaircase = verdictInput.staircases[1]!;
const resolvableCombo = verdictInput.combos[1]!;
const tierEnergy = (family: FamilyTable, tier: string): number =>
  family.rows.find(row => row.tier === tier)!.edgeEnergy;
const comboCombo = resolvableCombo.rows.find(row => row.tier === "msaa4+a2c+tsr")!;
const comboComboSmaa = resolvableCombo.rows.find(row => row.tier === "msaa4+a2c+tsr→smaa(combo,8bit)")!;
const gates = {
  gate1ComboReduction: {
    value: comboCombo.reduction,
    threshold: "≥80.0%",
    passed: parseFloat(comboCombo.reduction) >= 80,
    note: "可采样口径组合家族:MSAA4+a2c+TSR(16 帧理想化)相对 a2c 材质基线降幅(AA-M2 门①原判据)。",
  },
  smaaOnMsaa4: {
    resolvable: {
      before: tierEnergy(resolvableStaircase, "msaa4(analytic)"),
      after: tierEnergy(resolvableStaircase, "msaa4→smaa(hw-combo,8bit)"),
      passed: tierEnergy(resolvableStaircase, "msaa4→smaa(hw-combo,8bit)") <
        tierEnergy(resolvableStaircase, "msaa4(analytic)"),
    },
    undersampled: {
      before: tierEnergy(undersampledStaircase, "msaa4(analytic)"),
      after: tierEnergy(undersampledStaircase, "msaa4→smaa(hw-combo,8bit)"),
      passed: tierEnergy(undersampledStaircase, "msaa4→smaa(hw-combo,8bit)") <
        tierEnergy(undersampledStaircase, "msaa4(analytic)"),
    },
    note: "SMAA 的真实工作点(业界标准组合 MSAA4→SMAA):SMAA 吃残留 4 采样阶梯的 MSAA4 输出,是否再降能(同场景同尺)。",
  },
  smaaOnTemporalCombo: {
    resolvable: {
      before: tierEnergy(resolvableStaircase, "msaa4+tsr(analytic,16f)"),
      after: tierEnergy(resolvableStaircase, "msaa4+tsr→smaa(combo,8bit)"),
      passed: tierEnergy(resolvableStaircase, "msaa4+tsr→smaa(combo,8bit)") <
        tierEnergy(resolvableStaircase, "msaa4+tsr(analytic,16f)"),
    },
    comboFamily: { before: comboCombo.edgeEnergy, after: comboComboSmaa.edgeEnergy,
      passed: comboComboSmaa.edgeEnergy < comboCombo.edgeEnergy },
    note: "SMAA 吃时域收敛输出(MSAA4+TSR / MSAA4+a2c+TSR):如实记录——预期不再降能(SMAA 是空间修复器,时域收敛输出已无走样可修,邻域混合反而引入残差;真实链路中 SMAA 应作用于 MSAA4 输出而非时域收敛输出)。",
  },
};

const aamatrix = {
  schema: "aam2-final-matrix-v1",
  createdAt: new Date().toISOString(),
  caliberNote: "口径 A=欠采样极限(3px 周期细栅栏+1px 圆弧,采样定理下不可恢复,度量 AA 下界诚实性);口径 B=可采样(斜边/粗栅栏/粗圆弧全部满足采样定理,门①判定口径)。降幅口径:各家族内相对本家族 noAA 基线(alphaTest 组)或 a2c 基线(a2c 组,见 harness 表语义)。",
  ...verdictInput,
  gates,
  gpuSmaa: {} as Record<string, unknown>,
};

// GPU SMAA 探针证据合并(存在才并,不阻塞)。
for (const [key, dir] of [["undersampled-limit", "smaa-gpu-acceptance"], ["resolvable", "smaa-gpu-acceptance-resolvable"]] as const) {
  try {
    const evidence = JSON.parse(await readFile(new URL(`../../../test-output/deep-core/AAM2/${dir}/evidence.json`, import.meta.url), "utf8")) as
      { energy?: Record<string, string> };
    aamatrix.gpuSmaa[key] = evidence.energy ?? null;
  } catch { aamatrix.gpuSmaa[key] = null; }
}

await mkdir(outputDir, { recursive: true });
await writeFile(`${outputDir}final-matrix.json`, JSON.stringify(aamatrix, null, 2));
console.log(JSON.stringify(aamatrix, null, 2));
