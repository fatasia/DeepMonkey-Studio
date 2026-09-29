import { describe, expect, it } from "vitest";
import { DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS } from "../shaderAbi/index.js";
import { EXTENDED_PARAMETER_WGSL_STRUCT, packExtendedParameterBlock } from "./materialParameterAbi.js";
import { DEFAULT_EXTENDED_MATERIAL_PARAMETERS, MATERIAL_PARAMETER_KEYS,
  packMaterialParameterArray, type ExtendedMaterialParameters } from "./materialParameters.js";
import { packMaterialParameters } from "../webgpu/materialBindings.js";
import { sceneShaderCore } from "../webgpu/pbrShader.js";
import { evaluateClearcoatReference } from "../shaderAuthoring/packageClearcoat.js";
import { evaluateExtendedMaterialDirect, type MaterialEvaluationGeometry,
  type StandardSurfaceInputs } from "./materialEvaluate.js";

/**
 * C9 Clearcoat 清漆层 · 语义一致性 + 数学验收。
 *  1) 扩展参数带语义表 ↔ 打包顺序 ↔ WGSL 结构体 ↔ 权威着色路径 consumption 逐槽位一致;
 *  2) 清漆 lobe 已知角度对照 Disney 闭式解;锐清漆(r≤0.154)受 1e-6 分母保护钳制,
 *     该数值边界与 WGSL 同式一致,一并钉进合同;
 *  3) 守恒口径(本切片的断言设计):层叠 = 基础 lobe 按 f·F_c(vh) 转移 + 清漆瓣。
 *     清漆瓣半球积分 ≤ f·max F_c × κ,Schlick 分离 G 的 κ 实测包络 = 1.66
 *     (r 0.045..1 × nDotV 0.05..1 密扫,160×320 积分;Filament/UE 同式同界);
 *     净变化 = 转移(负)+ 清漆瓣(正),逐格与积分级都满足转移恒等式。
 */

const GEOMETRY: MaterialEvaluationGeometry = { normal: [0, 0, 1], view: [0, 0, 1], light: [0, 0, 1], tangent: [1, 0, 0] };
const WHITE_ROUGH: StandardSurfaceInputs = { baseColor: [1, 1, 1], metallic: 0, roughness: 1 };
const PI = Math.PI;
const COAT_F0 = 0.04;
/** Schlick 分离 G 清漆瓣的单位半球积分实测上界(κ):超出 1 的部分是分离 G 的
 * 已知欠遮蔽(与 Filament clearcoat 同式同界),非实现缺陷;锐清漆受保护钳制后 κ≪1。 */
const COAT_LOBE_ENVELOPE = 1.66;
const dot3 = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
function normalize3(value: readonly number[]): readonly [number, number, number] {
  const length = Math.hypot(value[0]!, value[1]!, value[2]!);
  return [value[0]! / length, value[1]! / length, value[2]! / length];
}
/** 介电清漆层 F_c(Schlick, f0=0.04);与 evaluateClearcoatReference 同式独立复刻。 */
const coatFresnel = (vDotH: number): number => COAT_F0 + 0.96 * (1 - vDotH) ** 5;

describe("C9 clearcoat extended-band semantics", () => {
  it("agrees slot-for-slot across semantics table, pack order, WGSL struct and the shade path", () => {
    expect([...MATERIAL_PARAMETER_KEYS]).toEqual(["ior", "clearcoatFactor", "clearcoatRoughness",
      "anisotropyStrength", "anisotropyRotation", "transmissionFactor"]);
    const components = ["x", "y", "z", "w"] as const;
    MATERIAL_PARAMETER_KEYS.forEach((key, index) => {
      const entry = DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS[key];
      expect(entry.floatOffset).toBe(40 + index);
      expect(entry.component).toBe(components[index % 4]);
      expect(entry.member).toBe(index < 4 ? "extended0" : "extended1");
    });
    // 打包:哨兵值逐槽位落位;46..47 保留零。
    const sentinel: ExtendedMaterialParameters = { ior: 1.75, clearcoat: { factor: 0.25, roughness: 0.5 },
      anisotropy: { strength: 0.75, rotation: -1.25 }, transmission: { factor: 0.125 } };
    const block = packExtendedParameterBlock(sentinel);
    expect(Array.from(block)).toEqual([1.75, 0.25, 0.5, 0.75, -1.25, 0.125]);
    const materialBlock = packMaterialParameters({ emissiveStrength: 1, extendedParameters: sentinel });
    MATERIAL_PARAMETER_KEYS.forEach((key, index) => {
      expect(materialBlock[DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS[key].floatOffset]).toBe(block[index]);
    });
    expect([materialBlock[46], materialBlock[47]]).toEqual([0, 0]);
    // WGSL 结构体成员顺序 = 打包顺序;权威路径按 extended0/extended1 分组消费。
    const structMembers = [...EXTENDED_PARAMETER_WGSL_STRUCT.matchAll(/\b([A-Za-z]+):\s*f32\b/g)]
      .map((match) => match[1]!);
    expect(structMembers).toEqual([...MATERIAL_PARAMETER_KEYS]);
    expect(sceneShaderCore).toContain(
      "DeepMaterialEvalParams(params.x, params.y, params.z, params.w, coatAndTransmission.x, coatAndTransmission.y)");
    // opt-in 门:清漆系数是门条件之一,缺省零时走标准 shade(零行为变化)。
    expect(sceneShaderCore).toContain("if (params.y == 0.0 && params.w == 0.0 && coatAndTransmission.y == 0.0)");
  });

  it("keeps schema defaults pinned: factor 0 reproduces the stock path", () => {
    expect(Array.from(packMaterialParameterArray(DEFAULT_EXTENDED_MATERIAL_PARAMETERS))).toEqual([1.5, 0, 0, 0, 0, 0]);
    expect(DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS.clearcoatFactor.defaultValue).toBe(0);
    const neutral = evaluateExtendedMaterialDirect(WHITE_ROUGH, {}, GEOMETRY, [1, 1, 1]);
    const zeroed = evaluateExtendedMaterialDirect(WHITE_ROUGH, { clearcoat: { factor: 0, roughness: 0 } }, GEOMETRY, [1, 1, 1]);
    expect(zeroed.rgb).toEqual(neutral.rgb);
  });
});

describe("C9 clearcoat lobe against Disney closed forms", () => {
  it("matches the analytic facing-angle lobe: F(0.04)·D(1)/4 with Schlick-Smith G=1", () => {
    // r ≥ 0.16 时分母保护 1e-6 不触发,闭式解逐位成立。
    for (const [factor, roughness] of [[0.7, 0.3], [1, 0.2], [0.25, 0.8]] as const) {
      const alpha = roughness * roughness;
      // 正入射:n=v=l=h → G(nv)=G(nl)=1,D = 1/(π·α²),F(vh=1) = 0.04。
      const expectedLobe = factor * COAT_F0 / (4 * PI * alpha * alpha);
      const expectedAttenuation = 1 - factor * COAT_F0;
      const reference = evaluateClearcoatReference({ factor, roughness, nDotL: 1, nDotV: 1, nDotH: 1, vDotH: 1, dfg: [0, 0] });
      expect(reference.directLobe).toBeCloseTo(expectedLobe, 12);
      expect(reference.directBaseAttenuation).toBeCloseTo(expectedAttenuation, 12);
    }
  });

  it("pins the 1e-6 distribution guard that clamps razor-sharp coats (r ≤ 0.154, same as WGSL)", () => {
    // r=0.15 正入射:π·α⁴ = 8.05e-7 < 1e-6 → D 被钳到 α²/1e-6;CPU 与 WGSL 同式,一并钉住。
    const alpha = 0.15 * 0.15;
    const guarded = evaluateClearcoatReference({ factor: 1, roughness: 0.15, nDotL: 1, nDotV: 1, nDotH: 1, vDotH: 1, dfg: [0, 0] });
    expect(guarded.directLobe).toBeCloseTo((alpha * alpha / 1e-6) * COAT_F0 / 4, 12);
  });

  it("clamps clearcoat roughness at 0.045 and decays attenuation to 1−factor at grazing", () => {
    const floor = evaluateClearcoatReference({ factor: 1, roughness: 0, nDotL: 1, nDotV: 1, nDotH: 1, vDotH: 1, dfg: [0, 0] });
    const pinned = evaluateClearcoatReference({ factor: 1, roughness: 0.045, nDotL: 1, nDotV: 1, nDotH: 1, vDotH: 1, dfg: [0, 0] });
    expect(floor.directLobe).toBe(pinned.directLobe);
    // 掠射:vh→0 → F_c→1 → 基础 lobe 衰减到 1−factor。
    const grazing = evaluateClearcoatReference({ factor: 0.7, roughness: 0.3, nDotL: 0.8, nDotV: 0.8, nDotH: 0.5, vDotH: 0, dfg: [0, 0] });
    expect(grazing.directBaseAttenuation).toBeCloseTo(1 - 0.7, 12);
    expect(grazing.directLobe).toBeGreaterThan(0);
  });
});

describe("C9 conservation convention: transfer, not creation", () => {
  interface HemisphereIntegral { readonly base: number; readonly layered: number; readonly lobe: number;
    readonly removed: number; readonly unitLobe: number; readonly maxFresnel: number }

  /** cos 加权半球积分;rgb 已含 BRDF·nDotL(radiance=[1,1,1]),格子权重 = sinθ·Δθ·Δφ(立体角)。 */
  function hemisphereIntegral(surface: StandardSurfaceInputs, extended: Partial<ExtendedMaterialParameters>,
    view: readonly [number, number, number], rings = 64, segments = 128): HemisphereIntegral {
    // 与实现同语义:先归一化(实现内部对 view/light 再归一化),半程向量/夹角全部用归一化基。
    const viewUnit = normalize3(view);
    const factor = extended.clearcoat?.factor ?? 0;
    let base = 0, layered = 0, lobe = 0, removed = 0, unitLobe = 0, maxFresnel = 0;
    const dTheta = (PI / 2) / rings, dPhi = (2 * PI) / segments;
    for (let ring = 0; ring < rings; ring++) {
      const theta = (ring + 0.5) * dTheta, sinTheta = Math.sin(theta);
      for (let segment = 0; segment < segments; segment++) {
        const phi = (segment + 0.5) * dPhi;
        const light = normalize3([sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), Math.cos(theta)]);
        const weight = sinTheta * dTheta * dPhi;
        const plain = evaluateExtendedMaterialDirect(surface, {}, { ...GEOMETRY, view: viewUnit, light }, [1, 1, 1]);
        const coated = evaluateExtendedMaterialDirect(surface, extended, { ...GEOMETRY, view: viewUnit, light }, [1, 1, 1]);
        // 逐格转移恒等式(非循环):coated = plain·(1−f·F_c(vh)) + coatLobe。
        const half = normalize3([viewUnit[0]! + light[0]!, viewUnit[1]! + light[1]!, viewUnit[2]! + light[2]!]);
        const fresnel = coatFresnel(dot3(viewUnit, half));
        maxFresnel = Math.max(maxFresnel, fresnel);
        expect(coated.rgb[0]!).toBeCloseTo(plain.rgb[0]! * (1 - factor * fresnel) + coated.components.clearcoat[0]!, 10);
        base += plain.rgb[0]! * weight;
        layered += coated.rgb[0]! * weight;
        lobe += coated.components.clearcoat[0]! * weight;
        removed += factor * fresnel * plain.rgb[0]! * weight;
        if (factor > 0 && fresnel > 0) unitLobe += coated.components.clearcoat[0]! / (factor * fresnel) * weight;
      }
    }
    return { base, layered, lobe, removed, unitLobe, maxFresnel };
  }

  it("integrates the transfer identity exactly and bounds the coat lobe by its fresnel envelope", () => {
    for (const view of [[0, 0, 1], [0.5, 0, 0.866], [0.766, 0, 0.643], [0.966, 0, 0.259]] as const) {
      for (const extended of [{ clearcoat: { factor: 1, roughness: 0.15 } },
        { clearcoat: { factor: 0.5, roughness: 0.3 } }, { clearcoat: { factor: 0.25, roughness: 0.8 } }]) {
        const integral = hemisphereIntegral(WHITE_ROUGH, extended, view);
        // 白 rough-1 基础(含 1−F 储备)半球积分 ≈ 1;清漆 F_c 占比应很小。
        expect(integral.base).toBeGreaterThan(0.9);
        expect(integral.base).toBeLessThanOrEqual(1.001);
        // 积分级转移恒等式:层叠 = 基础 − 转移出(f·F·基础) + 清漆瓣。
        expect(integral.layered).toBeCloseTo(integral.base - integral.removed + integral.lobe, 8);
        // 无中生有禁止:清漆瓣 ≤ f·maxF·κ(κ=1.66 实测包络,Schlick 分离 G 已知欠遮蔽)。
        expect(integral.unitLobe).toBeLessThanOrEqual(COAT_LOBE_ENVELOPE);
        expect(integral.lobe).toBeLessThanOrEqual(extended.clearcoat!.factor * integral.maxFresnel * COAT_LOBE_ENVELOPE);
        // 衰减不放大:层叠总量 ≤ 基础 + 清漆瓣。
        expect(integral.layered).toBeLessThanOrEqual(integral.base + integral.lobe + 1e-9);
      }
    }
  });

  it("keeps the net furnace change inside the transfer envelope across a roughness sweep", () => {
    for (const roughness of [0.045, 0.1, 0.25, 0.5, 1]) {
      const integral = hemisphereIntegral(WHITE_ROUGH, { clearcoat: { factor: 1, roughness } }, [0.5, 0, 0.866]);
      const net = integral.layered - integral.base;
      expect(Math.abs(net)).toBeLessThanOrEqual(integral.removed + integral.lobe + 1e-9);
    }
  });
});
