import { describe, expect, it } from "vitest";
import {
  BUILTIN_MATERIAL_PRESETS, capturePresetValues, expandMaterialPreset,
  shadeHexColor, validateMaterialPresetValues, type PresetMaterialValues,
} from "./industrialMaterialPresets";

/** 与 contracts/sceneValidation 同源的字段域(编辑器侧守门,防契约漂移)。 */
describe("内置工业预设数据表", () => {
  it("提供 8 个以上预设,且覆盖金属/非金属/玻璃与屏三个分组", () => {
    expect(BUILTIN_MATERIAL_PRESETS.length).toBeGreaterThanOrEqual(8);
    const groups = new Set(BUILTIN_MATERIAL_PRESETS.map(preset => preset.group));
    expect([...groups].sort()).toEqual(["glass-screen", "metal", "nonmetal"]);
  });

  it("每个预设 id 唯一,zh/en 名称非空", () => {
    const ids = BUILTIN_MATERIAL_PRESETS.map(preset => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of BUILTIN_MATERIAL_PRESETS) {
      expect(preset.zh.trim()).not.toBe("");
      expect(preset.en.trim()).not.toBe("");
    }
  });

  it("全部预设参数通过域校验(物理合理标定)", () => {
    for (const preset of BUILTIN_MATERIAL_PRESETS) {
      expect(validateMaterialPresetValues(preset.values), preset.id).toEqual([]);
    }
  });

  it("关键预设的物理标定值正确", () => {
    const stainless = BUILTIN_MATERIAL_PRESETS.find(preset => preset.id === "builtin.stainless-steel")!;
    expect(stainless.values.metalness).toBe(1);
    expect(stainless.values.roughness).toBeLessThan(0.3);
    const frosted = BUILTIN_MATERIAL_PRESETS.find(preset => preset.id === "builtin.frosted-glass")!;
    expect(frosted.values.transmission).toBeGreaterThan(0.5);
    expect(frosted.values.ior).toBeGreaterThanOrEqual(1.4);
    expect(frosted.values.metalness).toBe(0);
    const panel = BUILTIN_MATERIAL_PRESETS.find(preset => preset.id === "builtin.emissive-panel")!;
    expect(panel.values.emissive).toMatch(/^#[0-9a-f]{6}$/i);
    expect(panel.values.emissiveIntensity).toBeGreaterThan(0);
  });

  it("预设只携带标量外观域,不含贴图/屏幕/UV/特效字段", () => {
    const forbidden = ["baseColorMapUrl", "normalMapUrl", "emissiveMapUrl", "roughnessMapUrl", "metalnessMapUrl",
      "ambientOcclusionMapUrl", "screen", "uvAnimation", "shaderEffect", "customShader", "slotOverrides",
      "hue", "saturation", "brightness", "contrast"];
    for (const preset of BUILTIN_MATERIAL_PRESETS) {
      for (const key of forbidden) expect(preset.values, preset.id).not.toHaveProperty(key);
    }
  });
});

describe("validateMaterialPresetValues", () => {
  const valid: PresetMaterialValues = { color: "#c8c8c8", metalness: 1, roughness: 0.22 };

  it("合法参数零问题;color/metalness/roughness 必填", () => {
    expect(validateMaterialPresetValues(valid)).toEqual([]);
    expect(validateMaterialPresetValues({ metalness: 0, roughness: 0.5 }).length).toBeGreaterThan(0);
    expect(validateMaterialPresetValues({ color: "#ffffff", roughness: 0.5 }).length).toBeGreaterThan(0);
    expect(validateMaterialPresetValues({ color: "#ffffff", metalness: 0 }).length).toBeGreaterThan(0);
  });

  it("拒绝越界与非法值", () => {
    expect(validateMaterialPresetValues({ ...valid, metalness: 1.2 }).length).toBeGreaterThan(0);
    expect(validateMaterialPresetValues({ ...valid, roughness: -0.1 }).length).toBeGreaterThan(0);
    expect(validateMaterialPresetValues({ ...valid, color: "red" }).length).toBeGreaterThan(0);
    expect(validateMaterialPresetValues({ ...valid, ior: 0.9 }).length).toBeGreaterThan(0);
    expect(validateMaterialPresetValues({ ...valid, transmission: 1.5 }).length).toBeGreaterThan(0);
    expect(validateMaterialPresetValues({ ...valid, emissive: "#12345" }).length).toBeGreaterThan(0);
    expect(validateMaterialPresetValues({ ...valid, attenuationDistance: 0 }).length).toBeGreaterThan(0);
    expect(validateMaterialPresetValues(null as unknown as PresetMaterialValues).length).toBeGreaterThan(0);
  });

  it("透射玻璃的合法组合通过", () => {
    expect(validateMaterialPresetValues({
      color: "#e6eef0", metalness: 0, roughness: 0.6, transmission: 0.85, thickness: 0.5, ior: 1.52,
    })).toEqual([]);
  });
});

describe("expandMaterialPreset", () => {
  it("金属预设输出全量外观 patch:预设值 + 中性关闭值", () => {
    const patch = expandMaterialPreset({ color: "#c8c8c8", metalness: 1, roughness: 0.22 });
    expect(patch).toMatchObject({
      color: "#c8c8c8", metalness: 1, roughness: 0.22,
      emissive: "#000000", emissiveIntensity: 0,
      transmission: 0, thickness: 0,
      clearcoat: 0, clearcoatRoughness: 0,
      sheen: 0, sheenRoughness: 1, iridescence: 0,
    });
    expect(patch).not.toHaveProperty("baseColorMapUrl");
    expect(patch).not.toHaveProperty("slotOverrides");
    expect(patch).not.toHaveProperty("screen");
    expect(patch).not.toHaveProperty("shaderEffect");
  });

  it("预设显式值覆盖中性基线(玻璃/发光)", () => {
    const glass = expandMaterialPreset({ color: "#e6eef0", metalness: 0, roughness: 0.6, transmission: 0.85, thickness: 0.5, ior: 1.52 });
    expect(glass.transmission).toBe(0.85);
    expect(glass.thickness).toBe(0.5);
    expect(glass.ior).toBe(1.52);
    const panel = expandMaterialPreset({ color: "#0c0f12", metalness: 0, roughness: 0.25, emissive: "#58c6f2", emissiveIntensity: 2.5 });
    expect(panel.emissive).toBe("#58c6f2");
    expect(panel.emissiveIntensity).toBe(2.5);
    expect(panel.transmission).toBe(0);
  });

  it("展开结果不含 undefined 键(引擎 validatePhysicalLobePatch 对 lobe 字段显式 undefined 抛错)", () => {
    const patch = expandMaterialPreset({ color: "#ffffff", metalness: 0, roughness: 0.5 });
    for (const [key, value] of Object.entries(patch)) expect(value, key).not.toBeUndefined();
  });

  it("玻璃展开结果全部键值为有限确定值,可直接入契约材质域(transmission/thickness/ior 与 contracts 合法域一致)", () => {
    const patch = expandMaterialPreset({ color: "#e6eef0", metalness: 0, roughness: 0.6, transmission: 0.85, thickness: 0.5, ior: 1.52 });
    expect(patch.transmission).toBeGreaterThanOrEqual(0);
    expect(patch.transmission).toBeLessThanOrEqual(1);
    expect(patch.thickness).toBeLessThanOrEqual(1e6);
    expect(patch.ior).toBeGreaterThanOrEqual(1);
  });
});

describe("capturePresetValues", () => {
  it("只摘标量外观域,丢弃贴图/屏幕/校正/slotOverrides", () => {
    const captured = capturePresetValues({
      color: "#26292c", metalness: 0, roughness: 0.88,
      baseColorMapUrl: "blob:x", baseColorMapName: "tex.png",
      screen: { enabled: true, sourceType: "image", url: "x", autoplay: true, loopMode: "loop", muted: true, emissiveIntensity: 1 },
      uvAnimation: { enabled: true, offsetSpeedX: 1, offsetSpeedY: 0, rotationSpeed: 0 },
      shaderEffect: { kind: "fresnel-rim", color: "#ffffff", intensity: 1 },
      hue: 10, saturation: 0.2, brightness: -0.1, contrast: 0.05,
      slotOverrides: { "gltf:0": { color: "#111111" } },
      customShader: { source: "void main(){}" },
    });
    expect(captured).toEqual({ color: "#26292c", metalness: 0, roughness: 0.88 });
  });

  it("捕获值可直接作为预设数据通过域校验", () => {
    const captured = capturePresetValues({ color: "#a8a39a", metalness: 0, roughness: 0.9, emissiveIntensity: 3 });
    expect(validateMaterialPresetValues(captured)).toEqual([]);
  });
});

describe("shadeHexColor", () => {
  it("按比例调亮调暗并 clamp,非法输入原样返回", () => {
    expect(shadeHexColor("#000000", 0.5)).toBe("#808080");
    expect(shadeHexColor("#ffffff", -0.5)).toBe("#808080");
    expect(shadeHexColor("#ffffff", 1)).toBe("#ffffff");
    expect(shadeHexColor("#000000", -1)).toBe("#000000");
    expect(shadeHexColor("nonsense", 0.2)).toBe("nonsense");
  });
});
