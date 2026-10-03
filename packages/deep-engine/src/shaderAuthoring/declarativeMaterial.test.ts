import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { compileDeclarativeMaterial, lowerDeclarativeMaterial } from "@bim-studio/deep-engine/shader-authoring";

const PLAIN = `shader deep.material {
  surface standard;
  baseColor [0.2, 0.4, 0.6, 1];
  metallic 0;
  roughness 0.5;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`;
const COATED = PLAIN.replace("roughness 0.5;", "roughness 0.5;\n  clearcoatFactor 0.85;\n  clearcoatRoughness 0.08;");
const base = { id: "m", baseColor: [0.9, 0.9, 0.9] as [number, number, number], metallic: 0.1, roughness: 0.8 };

describe("declarative material lowering", () => {
  it("compiles plain and coated sources and rejects textures, invalid ranges and oversized input", () => {
    expect(compileDeclarativeMaterial(PLAIN).model.surface).toBe("standard");
    expect(compileDeclarativeMaterial(COATED).model.clearcoatFactor).toBeCloseTo(0.85);
    expect(() => compileDeclarativeMaterial(PLAIN.replace("baseColorTexture off;", "baseColorTexture on;"))).toThrow(/plain标量/);
    expect(() => compileDeclarativeMaterial(COATED.replace("clearcoatFactor 0.85;", "clearcoatFactor 1.5;"))).toThrow(/between 0 and 1/);
    expect(() => compileDeclarativeMaterial("x".repeat(33 * 1024))).toThrow(/32KiB/);
    // 缓存按原始字符串键;不同空白是不同条目、哈希反映真实源字节,但模型逐字段一致。
    const padded = compileDeclarativeMaterial(` ${PLAIN} `), exact = compileDeclarativeMaterial(PLAIN);
    expect(padded.model).toEqual(exact.model);
    expect(compileDeclarativeMaterial(PLAIN)).toBe(exact); // 同字符串命中缓存,身份稳定。
  });

  it("lowers scalars without extra layers and routes clearcoat through the existing stock layer", () => {
    const plain = lowerDeclarativeMaterial(base, compileDeclarativeMaterial(PLAIN));
    expect(plain.layered).toBeUndefined();
    expect(plain.baseColor).toEqual([0.2, 0.4, 0.6]);
    expect(plain.roughness).toBe(0.5);
    const coated = lowerDeclarativeMaterial(base, compileDeclarativeMaterial(COATED));
    expect(coated.layered?.layers).toHaveLength(1);
    expect(coated.layered?.layers[0]?.coverage).toBe(1);
    // f32 打包:fround(0.85) 是打包值,解析器产出与其一致。
    expect(coated.layered?.layers[0]?.params?.clearcoat?.factor).toBeCloseTo(0.85, 6);
    expect(coated.layered?.layers[0]?.params?.clearcoat?.roughness).toBeCloseTo(0.08, 6);
    const zero = lowerDeclarativeMaterial(base, compileDeclarativeMaterial(COATED.replace("clearcoatFactor 0.85;", "clearcoatFactor 0;")));
    expect(zero.layered).toBeUndefined();
  });

  it("lowers unlit without metallic response and keeps mask alpha semantics", () => {
    // 解析器 fail-closed:Unlit 不接受 metallic/roughness 声明(不许静默 no-op),夹具须去除。
    const unlitSource = PLAIN.replace("surface standard;", "surface unlit;")
      .replace("  metallic 0;\n", "").replace("  roughness 0.5;\n", "");
    const unlit = lowerDeclarativeMaterial(base, compileDeclarativeMaterial(unlitSource));
    expect(unlit.shadingModel).toBe("unlit");
    expect(unlit.metallic).toBe(0);
    const masked = lowerDeclarativeMaterial(base, compileDeclarativeMaterial(PLAIN.replace("alpha opaque;", "alpha mask;")));
    expect(masked.alphaMode).toBe("MASK");
    expect(masked.alphaCutoff).toBe(0.5);
  });
});
