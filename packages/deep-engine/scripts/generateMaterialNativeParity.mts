/**
 * C9/native 材质扩展带双端对拍 fixture 生成器(TS 侧)。
 *
 * 单源 fixture:packages/deep-engine/fixtures/material-native-parity-v1.json
 *   - TS 段(生产 CPU 权威):
 *     · evaluateExtendedMaterialDirect(shader/materialEvaluate.ts,f64)——
 *       扩展带 clearcoat 层叠直接光(ior/clearcoat/各向异性/透射全家)rgb+四分量;
 *     · materialAdvancedReference.ts(f64)——sheen 数学原语
 *       dCharlie / vNeubelt / iblSheenBrdf / fSchlick 与
 *       sheenDirectBrdf / sheenDirectEnergy / sheenIndirectEnergy;
 *     · packMaterialParameterArray(扩展带 6 词)与
 *       packAdvancedParameterBlock(advanced 带 12 词)的 f32 打包词。
 *   - Rust 段:无占位 —— native 镜像(material_extended_cpu)从 inputs 段重算
 *     并与 TS 段对拍(deep-engine-native::material_parity_tests)。
 * 重跑本脚本即可让 TS 权威行为变化显式落进 git diff。
 *
 * 运行:仓库根 `node_modules/.bin/tsx packages/deep-engine/scripts/generateMaterialNativeParity.mts`
 *
 * 对拍纪律(与 megalights/sdf-gi 先例同构):
 * - f64 标量/向量:相对误差 ≤1e-9(Rust f64 镜像与 TS 同式,唯 pow/libm 跨库哨兵);
 * - f32 词(打包带):位级相等(TS fround 后词与 Rust as f32 必须逐位一致);
 * - 求值输出另发 f32 词列供 ≤2 ulp 档核对(f64 链 1e-9 传播后的落点裕度)。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateExtendedMaterialDirect, type MaterialEvaluationGeometry,
  type StandardSurfaceInputs, type Vec3 } from "../src/shader/materialEvaluate.js";
import type { ExtendedMaterialParameters } from "../src/shader/materialParameters.js";
import { packMaterialParameterArray } from "../src/shader/materialParameters.js";
import { packAdvancedParameterBlock, type AdvancedMaterialParameters } from "../src/shader/materialAdvancedParameters.js";
import { dCharlie, fSchlick, iblSheenBrdf, sheenDirectBrdf, sheenDirectEnergy,
  sheenIndirectEnergy, vNeubelt } from "../src/shader/materialAdvancedReference.js";

const fround = (value: number): number => Math.fround(value);

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** 与 native GPU 探针同构的几何:法线 [0,0,1](墙腿朝相机),三观察角取
 * materialGoldens 同款(normal/mid/grazing),光向固定。 */
const GEOMETRY_VIEWS: readonly { label: string; view: Vec3 }[] = [
  { label: "normal", view: [0, 0, 1] },
  { label: "mid", view: normalize([0.6, 0, 0.8]) },
  { label: "grazing", view: normalize([0.94, 0, 0.342]) },
];
const LIGHT: Vec3 = normalize([0.45, 0.3, 0.84]);
const NORMAL: Vec3 = [0, 0, 1];
const TANGENT: Vec3 = [1, 0, 0];

// ===== 扩展带(clearcoat)黄金矩阵:车漆/清漆碳纤维/白介电 × 2 因子 × 2 粗糙度 × 3 视角
// + 一行全缺省(stock 等价行)。radiance=[1,1,1](BRDF 级对照)。=====
const EXTENDED_SURFACES: readonly { id: string; surface: StandardSurfaceInputs; extended: Partial<ExtendedMaterialParameters> }[] = [
  { id: "car-paint", surface: { baseColor: [0.043, 0.14, 0.42], metallic: 0.9, roughness: 0.4 },
    extended: { ior: 1.5, clearcoat: { factor: 0.9, roughness: 0.35 } } },
  { id: "coated-carbon", surface: { baseColor: [0.02, 0.02, 0.022], metallic: 0, roughness: 0.55 },
    extended: { ior: 1.52, clearcoat: { factor: 0.6, roughness: 0.5 } } },
  { id: "white-dielectric", surface: { baseColor: [1, 1, 1], metallic: 0, roughness: 0.5 }, extended: {} },
];

const extendedCases = EXTENDED_SURFACES.flatMap(({ id, surface, extended }) =>
  GEOMETRY_VIEWS.map(({ label, view }) => ({
    id: `${id}@${label}`,
    surface,
    extended,
    geometry: { normal: NORMAL, view, light: LIGHT, tangent: TANGENT },
    radiance: [1, 1, 1] as Vec3,
  })));

// ===== sheen 原语网格与直射/能量矩阵(materialAdvancedReference.ts 同输入)。=====
const SHEEN_ROUGHNESS = [0.2, 0.6, 1.0];
const SHEEN_NH = [0.2, 0.55, 0.95];
const SHEEN_NV = [0.15, 0.5, 0.9];
const SHEEN_NL = [0.25, 0.65, 1.0];
const SCHLICK_COSINES = [0.05, 0.3, 0.7, 1.0];
const SHEEN_COLORS: readonly Vec3[] = [[0.35, 0.3, 0.25], [0.04, 0.04, 0.05], [1, 1, 1]];

const sheenCases = SHEEN_COLORS.flatMap(color =>
  SHEEN_ROUGHNESS.flatMap(roughness =>
    SHEEN_NV.flatMap(nv =>
      SHEEN_NL.map(nl => ({ color, roughness, nv, nl })))));

// ===== 打包带:扩展带 6 词(缺省/车漆/全字段)与 advanced 带 12 词(sheen 缺省/
// 有 sheen/含 iridescence+volume 全域——native 合同拒绝后两者非零,但打包域
// 仍按 TS 全域钉版,槽位写零由 native 打包器合同保证)。=====
const packExtendedCases: readonly { label: string; params: ExtendedMaterialParameters }[] = [
  { label: "defaults", params: { ior: 1.5, clearcoat: { factor: 0, roughness: 0 },
    anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 0 } } },
  { label: "car-paint", params: { ior: 1.5, clearcoat: { factor: 0.9, roughness: 0.35 },
    anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 0 } } },
  { label: "full-domain", params: { ior: 1.52, clearcoat: { factor: 1, roughness: 0.045 },
    anisotropy: { strength: 0.8, rotation: 0.6 }, transmission: { factor: 1 } } },
];

const packAdvancedCases: readonly { label: string; params: AdvancedMaterialParameters }[] = [
  { label: "defaults", params: {} },
  { label: "sheen", params: { sheen: { color: [0.35, 0.3, 0.25], roughness: 0.6 } } },
  { label: "sheen-defaults-mixed", params: { sheen: { color: [0, 0, 0], roughness: 1 } } },
];

const f64 = (value: number): number => value;
const words = (values: ArrayLike<number>): number[] => Array.from(values, value => fround(value));
const vec3Json = (value: Vec3): number[] => [f64(value[0]), f64(value[1]), f64(value[2])];

const extended = extendedCases.map((testCase, index) => {
  const result = evaluateExtendedMaterialDirect(testCase.surface, testCase.extended, testCase.geometry, testCase.radiance);
  return {
    index,
    rgb: vec3Json(result.rgb),
    rgbWords: words(result.rgb),
    diffuse: vec3Json(result.components.diffuse),
    specular: vec3Json(result.components.specular),
    clearcoat: vec3Json(result.components.clearcoat),
    transmission: vec3Json(result.components.transmission),
  };
});

const sheenPrimitives = {
  dCharlie: SHEEN_ROUGHNESS.map(roughness => SHEEN_NH.map(nh => f64(dCharlie(roughness, nh)))),
  vNeubelt: SHEEN_NV.map(nv => SHEEN_NL.map(nl => f64(vNeubelt(nv, nl)))),
  iblSheenBrdf: SHEEN_NV.map(nv => SHEEN_ROUGHNESS.map(roughness => f64(iblSheenBrdf(nv, roughness)))),
  fSchlick: SCHLICK_COSINES.map(cosine => f64(fSchlick(0.04, cosine))),
};

const sheen = sheenCases.map((testCase, index) => {
  const nh = 0.55;
  return {
    index,
    directBrdf: vec3Json(sheenDirectBrdf(testCase.color, testCase.roughness, testCase.nv, testCase.nl, nh)),
    directBrdfWords: words(sheenDirectBrdf(testCase.color, testCase.roughness, testCase.nv, testCase.nl, nh)),
    directEnergy: f64(sheenDirectEnergy(testCase.color, testCase.roughness, testCase.nv, testCase.nl)),
    indirectEnergy: f64(sheenIndirectEnergy(testCase.color, testCase.roughness, testCase.nv)),
    nh,
  };
});

const fixture = {
  version: 1,
  generatedBy: "packages/deep-engine/scripts/generateMaterialNativeParity.mts",
  contract: "material-native-parity-v1",
  inputs: {
    extendedCases,
    sheenPrimitiveGrid: {
      roughness: SHEEN_ROUGHNESS, nh: SHEEN_NH, nv: SHEEN_NV, nl: SHEEN_NL, cosines: SCHLICK_COSINES,
    },
    sheenCases,
    packExtendedCases: packExtendedCases.map(({ label, params }) => ({ label, params })),
    packAdvancedCases: packAdvancedCases.map(({ label, params }) => ({ label, params })),
  },
  ts: {
    extended,
    sheenPrimitives,
    sheen,
    packExtended: packExtendedCases.map(({ params }) => words(packMaterialParameterArray(params))),
    packAdvanced: packAdvancedCases.map(({ params }) => words(packAdvancedParameterBlock(params))),
  },
};

const target = resolve(import.meta.dirname!, "../fixtures/material-native-parity-v1.json");
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`material native parity fixture written: ${target}`);
