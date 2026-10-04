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
    expect(sceneShader).toContain("@group(0) @binding(12) var<storage, read> deepVsmMeta : array<vec4u>;");
    expect(sceneShader).toContain("@group(0) @binding(13) var<storage, read> deepVsmLayers : array<i32>;");
    expect(sceneShader).toContain("@group(0) @binding(14) var deepVsmAtlas : texture_2d_array<f32>;");
  });

  it("keeps the zero-hole fallback chain and page-local clamped PCSS taps in the library", () => {
    expect(VIRTUAL_SHADOW_WGSL).toContain("struct DeepVsmHit");
    // 环内就近驻留 mip 搜索(M2 真机教训:粗向单链直达被钉住的顶 mip,细杆阴影全亮)
    // —— 期望 mip 就近双向走查,同距先粗后细;三环全缺 = 1.0。
    expect(VIRTUAL_SHADOW_WGSL).toContain("for (var distance = 0u; distance <= top; distance = distance + 1u)");
    expect(VIRTUAL_SHADOW_WGSL).toContain("let fine = i32(desired) - i32(distance);");
    // 命中细页时滤波宽度按请求足迹自宽(max(页 texel, 足迹)),细页不欠采样。
    expect(VIRTUAL_SHADOW_WGSL).toContain("max(ringTexel * exp2(f32(coarse)), footprintWorld)");
    expect(VIRTUAL_SHADOW_WGSL).toContain("max(ringTexel * exp2(f32(fine)), footprintWorld)");
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

  // CPU 镜像(与 deepVsmResolveRing 走查逐行同构):就近驻留 mip 搜索,同距先粗后细,
  // 命中 texelWorld = max(页 mip texel, 请求足迹)。WGSL 为字符串,功能性合同由本镜像锁定。
  function resolveMipMirror(resident: ReadonlySet<number>, desired: number, top: number,
    footprintScale: number): { mip: number; visited: number[]; texelScale: number } | { mip: -1; visited: number[]; texelScale: 0 } {
    const visited: number[] = [];
    for (let distance = 0; distance <= top; distance++) {
      const coarse = desired + distance;
      if (coarse <= top) {
        visited.push(coarse);
        if (resident.has(coarse)) {
          return { mip: coarse, visited, texelScale: Math.max(2 ** coarse, footprintScale) };
        }
      }
      if (distance === 0) continue;
      const fine = desired - distance;
      if (fine >= 0) {
        visited.push(fine);
        if (resident.has(fine)) {
          return { mip: fine, visited, texelScale: Math.max(2 ** fine, footprintScale) };
        }
      }
    }
    return { mip: -1, visited, texelScale: 0 };
  }

  it("resolves the nearest resident mip both directions with coarse-first ties (CPU mirror)", () => {
    // 接收像素期望 mip 3,遮挡体页物化在 mip 2(更细):必须命中 mip2 而非被钉住的顶页。
    const missTop = resolveMipMirror(new Set([2, 7]), 3, 7, 2 ** 2.9);
    expect(missTop).toEqual({ mip: 2, visited: [3, 4, 2], texelScale: 2 ** 2.9 });
    // 期望页自身驻留:零走查直接命中,滤波宽度 = 页 texel(足迹更细时按足迹)。
    expect(resolveMipMirror(new Set([3]), 3, 7, 2 ** 2.2)).toEqual({ mip: 3, visited: [3], texelScale: 2 ** 3 });
    // 全细页缺失:粗向走查到钉住顶页(零洞合同保持)。
    expect(resolveMipMirror(new Set([7]), 0, 7, 1)).toEqual({ mip: 7, visited: [0, 1, 2, 3, 4, 5, 6, 7], texelScale: 128 });
    // 期望粗于驻留:同距先粗后细,粗页(4)优先于细页(2)。
    expect(resolveMipMirror(new Set([2, 4]), 3, 7, 2 ** 3.1).mip).toBe(4);
    // 全缺 = miss(三环全缺才返回 1.0,由 deepVirtualShadow 环链兜底)。
    expect(resolveMipMirror(new Set(), 5, 7, 2 ** 5).mip).toBe(-1);
  });

  it("writes linear light depth from builtin z in page materialization fragments", () => {
    expect(sceneShader).toContain("@fragment fn shadowPageDepth(@builtin(position) fragCoord: vec4f) -> @location(0) f32 {\n  return fragCoord.z;\n}");
    // 页管线仅 solid 档:mask 变体移除(texture alpha 叶类按实心投影,documented)。
    expect(sceneShader).not.toContain("ShadowPageMaskInput");
    expect(sceneShader).not.toContain("shadowPageMaskTextured");
  });
});
