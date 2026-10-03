import { describe, expect, it } from "vitest";
import { packVirtualShadowPageTable, packVirtualShadowSlot, VIRTUAL_SHADOW_WGSL } from "./virtualShadowSampling.js";
import { packVirtualShadowUniform, VIRTUAL_SHADOW_PAGE_FRAME_SLOTS } from "./virtualShadowResources.js";
import { planVirtualShadowClipmap } from "../shadows/virtualShadowClipmap.js";
import { sceneShader } from "./pbrShader.js";

describe("virtual shadow page table packing", () => {
  it("packs slots losslessly in layer·256 + tileY·16 + tileX order", () => {
    expect(packVirtualShadowSlot(0, 0, 0)).toBe(0);
    expect(packVirtualShadowSlot(1, 3, 5)).toBe(256 + 5 * 16 + 3);
    expect(packVirtualShadowSlot(3, 15, 15)).toBe(3 * 256 + 15 * 16 + 15);
    expect(() => packVirtualShadowSlot(256, 0, 0)).toThrow();
    expect(() => packVirtualShadowSlot(-1, 0, 0)).toThrow();
    expect(() => packVirtualShadowSlot(0, 16, 0)).toThrow();
  });

  it("lays out per-(ring, mip) meta rows with cumulative layer bases and -1 sentinels", () => {
    const packing = packVirtualShadowPageTable(3, () => undefined);
    expect(packing.params).toEqual(new Uint32Array([3, 8, 128, 16384]));
    // mip 0 网格 128²,顶 mip 1²;layers 总长 = ringCount × Σ grid²(环段基址 = 前环整段长)。
    const perRing = Array.from({ length: 8 }, (_, mip) => (128 >> mip) ** 2).reduce((a, b) => a + b, 0);
    expect(perRing).toBe(21845);
    expect(packing.layers).toHaveLength(perRing * 3);
    expect([...packing.layers].every(value => value === -1)).toBe(true);
    const metaRow = (ring: number, mip: number) => packing.meta.slice((ring * 8 + mip) * 4, (ring * 8 + mip) * 4 + 4);
    expect([...metaRow(0, 0)]).toEqual([128, 128, 0, 0]);
    expect([...metaRow(0, 1)]).toEqual([64, 64, 128 * 128, 0]);
    expect([...metaRow(1, 0)]).toEqual([128, 128, perRing, 0]);
  });

  it("writes caller-provided packed slots and keeps missing pages at -1", () => {
    const packing = packVirtualShadowPageTable(2, (ring, mip, tileX, tileY) =>
      ring === 1 && mip === 7 ? packVirtualShadowSlot(2, 0, 0) : undefined);
    expect(packing.layers.at(-1)).toBe(packVirtualShadowSlot(2, 0, 0));
    expect([...packing.layers].filter(value => value >= 0)).toHaveLength(1);
  });
});

describe("virtual shadow uniform ABI", () => {
  it("packs ring matrices into the 640B cascade block with params2 mode switch", () => {
    const plan = planVirtualShadowClipmap({ eye: [0, 4, 12], target: [0, 0, 0],
      verticalFovRadians: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 1_000, extent: 10 }, [-0.4, -0.8, -0.3]);
    const data = packVirtualShadowUniform(plan, 0.5, 0.002);
    expect(data).toHaveLength(160);
    plan.rings.forEach((ring, index) => expect(data.slice(index * 16, index * 16 + 16))
      .toEqual(new Float32Array(ring.viewProjection)));
    expect(data[128]).toBeCloseTo(plan.rings[0]!.depthSpan, 6);
    expect(data[129]).toBeCloseTo(plan.rings[1]!.depthSpan, 6);
    expect(data[130]).toBeCloseTo(plan.rings[2]!.depthSpan, 6);
    expect(data[144]).toBeCloseTo(plan.rings[0]!.texelWorldSize, 9);
    expect(data[145]).toBeCloseTo(plan.rings[1]!.texelWorldSize, 9);
    expect(data[146]).toBeCloseTo(plan.rings[2]!.texelWorldSize, 9);
    expect(data[147]).toBe(16384);
    expect(data[148]).toBeCloseTo(0.5, 6);   // pcssLightWorld
    expect(data[149]).toBeCloseTo(0.002, 6); // depthBiasNorm
    expect([...data.slice(156, 160)]).toEqual([1, 3, 7, 128]);
  });

  it("allocates one frame buffer slot per render-page cap", () => {
    expect(VIRTUAL_SHADOW_PAGE_FRAME_SLOTS).toBe(8);
  });
});

describe("virtual shadow WGSL composition", () => {
  it("branches the primary shadow before cascades only in virtual mode and declares group-2 page bindings", () => {
    const gate = sceneShader.slice(sceneShader.indexOf("fn deepPrimaryShadow("),
      sceneShader.indexOf("struct DirectDisplayVertex"));
    expect(gate).toContain("if (frame.background.w <= 0.0 || flag(flags, 16u)) { return 1.0; }");
    // 虚拟分支位于级联采样之前,且由 params2.x 门控(级联档恒 0,行为逐字节保持)。
    // 环梯度在函数顶部一致流预取(fwidth ×3,任何分支之前),7 参合同传入。
    expect(gate).toContain("if (deepCascade.params2.x > 0.5) { return deepVirtualShadow(world, normal, nDotL, pixel, grad0, grad1, grad2); }");
    expect(gate.match(/fwidth\(/g)?.length).toBe(3);
    expect(gate.indexOf("fwidth(")).toBeLessThan(gate.indexOf("if (frame.background.w"));
    expect(gate.indexOf("deepCascade.params2.x")).toBeLessThan(gate.indexOf("deepCascadedShadow("));
    expect(sceneShader).toContain("@group(2) @binding(3) var<storage, read> deepVsmMeta : array<vec4u>;");
    expect(sceneShader).toContain("@group(2) @binding(4) var<storage, read> deepVsmLayers : array<i32>;");
    expect(sceneShader).toContain("@group(2) @binding(5) var deepVsmAtlas : texture_2d_array<f32>;");
  });

  it("keeps the zero-hole fallback chain and page-local clamped PCSS taps in the library", () => {
    expect(VIRTUAL_SHADOW_WGSL).toContain("struct DeepVsmHit");
    // 环内粗 mip 回退链:miss → mip+1,直到顶 mip;三环全缺 = 1.0。
    expect(VIRTUAL_SHADOW_WGSL).toContain("if (mip >= deepVsmTopMip()) { break; }");
    expect(VIRTUAL_SHADOW_WGSL).toContain("if (resolved || ring >= rings) { break; }");
    expect(VIRTUAL_SHADOW_WGSL).toContain("return result;");
    // PCSS:遮挡搜索 + 半影随遮挡距离,页内 clamp 防跨页渗色。
    expect(VIRTUAL_SHADOW_WGSL).toContain("let penumbraWorld = lightWorld * max(receiverDepth - blocker, 0.0)");
    expect(VIRTUAL_SHADOW_WGSL).toContain("clamp(pageTexel, vec2f(0.5), vec2f(edge - 0.5))");
    // AA-M1 联调:环梯度预取上移到 deepPrimaryShadow 顶部(flags 非一致分支之前),
    // 库内零 fwidth —— 回退链是发散控制流,库体必须无导数。
    expect(VIRTUAL_SHADOW_WGSL).not.toContain("fwidth(");
    const chain = VIRTUAL_SHADOW_WGSL.slice(VIRTUAL_SHADOW_WGSL.indexOf("var resolved = false;"));
    expect(chain).not.toContain("fwidth(");
  });

  it("writes linear light depth from builtin z in page materialization fragments", () => {
    expect(sceneShader).toContain("@fragment fn shadowPageDepth(@builtin(position) fragCoord: vec4f) -> @location(0) f32 {\n  return fragCoord.z;\n}");
    expect(sceneShader).toContain("struct ShadowPageMaskInput");
    expect(sceneShader).toContain("@fragment fn shadowPageMaskTextured(");
  });
});
