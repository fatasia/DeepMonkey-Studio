import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTENDED_MATERIAL_PARAMETERS,
  type ExtendedMaterialParameters } from "../shader/materialParameters.js";
import { packExtendedParameterBlock } from "../shader/materialParameterAbi.js";
import { DEEP_PBR_MESH_V1_BYTE_SIZES,
  DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS } from "../shaderAbi/contract.js";
import { MATERIAL_PARAMETER_CORE_FLOATS, MATERIAL_PARAMETER_EXTENDED_BAND_FLOAT_OFFSET,
  MATERIAL_PARAMETER_FLOATS, packMaterialParameters, createMaterialBinding, materialBindingMatches } from "./materialBindings.js";
import type { DeviceSession } from "./deviceSession.js";
import type { TextureBinding } from "./textureResources.js";
import { MATERIAL_ARRAY_TABLE_ROW_BYTES, MATERIAL_ARRAY_INDICES_BYTES } from "./textureArrayMaterialTable.js";

function textures(overrides: Partial<Parameters<typeof packMaterialParameters>[0]> = {}):
  Parameters<typeof packMaterialParameters>[0] {
  return { emissiveStrength: 1, ...overrides };
}

/** G-1 回归网:材质块打包器与 WGSL MaterialTextures(12 vec4)/Rust mesh_abi(40 float 基础块)
 * 的跨引擎对齐合同。崩溃史:1e07cdaf 给 WGSL 结构体加 extended0/extended1(160→192B)后,
 * 无扩展参数材质仍按 40 float 上传,DrawIndexed 校验以 `160<192` 失败。 */
describe("material parameter block ABI (G-1, 192B constant layout)", () => {
  it("binds both real specular resources and invalidates a changed texture view", () => {
    const group = vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup);
    const session = { device: { createBindGroup: group } } as unknown as DeviceSession;
    const slot = { texture: "specular", texCoord: 0 as const, uvTransform: [1, 0, 0, 0, 1, 0] as const };
    const factor = { ...slot, texture: "intensity" };
    const material = textures({ specularFactor: .5, specular: factor, specularColor: slot });
    const color = { view: { id: "color" }, sampler: { id: "sampler" } } as unknown as TextureBinding;
    const intensity = { view: { id: "intensity" }, sampler: { id: "sampler" } } as unknown as TextureBinding;
    const lookup = (id: string) => id === "specular" ? color : intensity;
    const binding = createMaterialBinding(session, { material: {} as GPUBindGroupLayout, advancedMaterials: true },
      material, lookup, {} as GPUBuffer)!;
    expect(group.mock.calls[0]![0].entries).toContainEqual({ binding: 16, resource: intensity.view });
    expect(group.mock.calls[0]![0].entries).toContainEqual({ binding: 18, resource: color.view });
    expect(materialBindingMatches(binding, material, lookup)).toBe(true);
    expect(materialBindingMatches(binding, material, id => id === "specular" ? { ...color } : intensity)).toBe(false);
    expect(() => createMaterialBinding(session, { material: {} as GPUBindGroupLayout }, material, lookup))
      .toThrow("advanced-materials/not-enabled");
  });
  it("packs independent specular factors and UV transforms only in the advanced variant", () => {
    const material = textures({ specularFactor: .25, specularColorFactor: [2, .5, .75],
      specular: { texture: "intensity", texCoord: 1, uvTransform: [2, 0, .1, 0, 3, .2] },
      specularColor: { texture: "color", texCoord: 0, uvTransform: [1, 0, 0, 0, 1, 0] } });
    const packed = packMaterialParameters(material, true);
    expect(packed.byteLength).toBe(320);
    expect([...packed.slice(60, 64)]).toEqual([2, .5, .75, .25]);
    expect([...packed.slice(64, 68)]).toEqual([2, 0, Math.fround(.1), 2]);
    expect([...packed.slice(72, 76)]).toEqual([1, 0, 0, 1]);
    expect(packMaterialParameters(material)).toEqual(packMaterialParameters(textures()));
  });
  it("always emits the full 48-float block the WGSL MaterialTextures struct requires", () => {
    const packed = packMaterialParameters(textures());
    expect(MATERIAL_PARAMETER_FLOATS).toBe(48);
    expect(packed.length).toBe(MATERIAL_PARAMETER_FLOATS);
    expect(packed.byteLength).toBe(192);
    // Rust 侧基础块 40 float(mesh_abi::MATERIAL_UNIFORM_FLOATS)是本布局的前缀;
    // 160B 是 DEEP_PBR_MESH_V1_BYTE_SIZES.material,192B = 160B + 32B 扩展带。
    expect(MATERIAL_PARAMETER_CORE_FLOATS).toBe(40);
    expect(packed.byteLength).toBe(DEEP_PBR_MESH_V1_BYTE_SIZES.material + 32);
  });

  it("zero-fills the extended band for plain materials (WGSL falls back to the standard shade branch)", () => {
    const packed = packMaterialParameters(textures());
    expect(Array.from(packed.slice(MATERIAL_PARAMETER_EXTENDED_BAND_FLOAT_OFFSET)))
      .toEqual(new Array<number>(MATERIAL_PARAMETER_FLOATS - MATERIAL_PARAMETER_EXTENDED_BAND_FLOAT_OFFSET).fill(0));
  });

  it("lands the 6-float extended parameter block at float offset 40 and keeps the tail zero", () => {
    const extended: ExtendedMaterialParameters = { ...DEFAULT_EXTENDED_MATERIAL_PARAMETERS,
      clearcoat: { factor: 0.5, roughness: 0.25 }, anisotropy: { strength: 0.75, rotation: 1.25 },
      transmission: { factor: 0.125 } };
    const packed = packMaterialParameters(textures({ extendedParameters: extended }));
    const expected = packExtendedParameterBlock(extended);
    expect(expected.length).toBe(6);
    expect(Array.from(packed.slice(40, 46))).toEqual(Array.from(expected));
    expect(packed[46]).toBe(0);
    expect(packed[47]).toBe(0);
  });

  it("keeps the 40-float core block byte-identical regardless of extended parameters", () => {
    const extended: ExtendedMaterialParameters = { ...DEFAULT_EXTENDED_MATERIAL_PARAMETERS,
      clearcoat: { factor: 1, roughness: 0.5 } };
    const plain = packMaterialParameters(textures());
    const withExtended = packMaterialParameters(textures({ extendedParameters: extended }));
    expect(Array.from(plain.slice(0, MATERIAL_PARAMETER_CORE_FLOATS)))
      .toEqual(Array.from(withExtended.slice(0, MATERIAL_PARAMETER_CORE_FLOATS)));
    // 语义表锚点:emissiveStrength 固定在 emissiveRow1.w(float 39),不被布局扩展移动。
    expect(DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS.emissiveStrength.floatOffset).toBe(39);
    plain[39] = 2;
    expect(plain[39]).toBe(2);
  });

  it("keeps the texture-array shared-table row stride self-consistent over the padded block", () => {
    // 行距合同(1e07cdaf 起):material + 32B 语义带 + 32B 索引 = 224B;
    // 打包器恒定 192B 后,`material + 32` 数值上恰为扩展带补齐后的整块(192B),行内两种
    // 材质(有/无扩展参数)的索引偏移一致,共享表无需分叉。
    expect(MATERIAL_ARRAY_TABLE_ROW_BYTES).toBe(MATERIAL_PARAMETER_FLOATS * Float32Array.BYTES_PER_ELEMENT
      + MATERIAL_ARRAY_INDICES_BYTES);
    expect(MATERIAL_ARRAY_TABLE_ROW_BYTES).toBe(224);
  });

  it("C9: clearcoat-only parameters land at the semantic slots 41/42 with the rest of the band zero", () => {
    const extended: ExtendedMaterialParameters = { ...DEFAULT_EXTENDED_MATERIAL_PARAMETERS,
      clearcoat: { factor: 0.85, roughness: 0.2 } };
    const packed = packMaterialParameters(textures({ extendedParameters: extended }));
    const semantics = DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS;
    // 打包走 float32 语义,哨兵值按 fround 比较。
    expect(packed[semantics.clearcoatFactor.floatOffset]).toBe(Math.fround(0.85));
    expect(packed[semantics.clearcoatRoughness.floatOffset]).toBe(Math.fround(0.2));
    expect(packed[semantics.ior.floatOffset]).toBe(semantics.ior.defaultValue);
    // 非清漆槽位保持缺省零:anisotropy/transmission 不被清漆启用。
    expect([packed[43], packed[44], packed[45], packed[46], packed[47]]).toEqual([0, 0, 0, 0, 0]);
  });

  it("C9: default extended parameters zero every gate slot; only the non-gating IOR slot differs", () => {
    // WGSL opt-in 门只看 clearcoatFactor/anisotropyStrength/transmissionFactor;
    // 缺省参数在全部门槽位为零 → GPU 走标准 shade 分支,与无扩展参数逐像素同帧。
    const defaults = packMaterialParameters(textures({ extendedParameters: DEFAULT_EXTENDED_MATERIAL_PARAMETERS }));
    const plain = packMaterialParameters(textures());
    const gateSlots = [DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS.clearcoatFactor.floatOffset,
      DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS.anisotropyStrength.floatOffset,
      DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS.transmissionFactor.floatOffset];
    for (const slot of gateSlots) {
      expect(defaults[slot]).toBe(0);
      expect(defaults[slot]).toBe(plain[slot]);
    }
    expect(defaults[DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS.ior.floatOffset])
      .toBe(DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS.ior.defaultValue);
  });
});
