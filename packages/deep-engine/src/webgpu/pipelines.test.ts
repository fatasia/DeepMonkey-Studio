import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";
import { createPipelines, createPipelinesBuild, PBR_FRAME_FLOAT_OFFSETS, PBR_FRAME_UNIFORM_BYTES, PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT } from "./pipelines.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { RED: 1, ALL: 15 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(messages: readonly GPUCompilationMessage[] = []) {
  const descriptors: GPURenderPipelineDescriptor[] = [], layouts: GPUBindGroupLayoutDescriptor[] = [];
  const pipelineLayouts: GPUPipelineLayoutDescriptor[] = [];
  const shader = { getCompilationInfo: vi.fn(async () => ({ messages })) } as unknown as GPUShaderModule;
  const device = {
    createShaderModule: vi.fn(() => shader),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => { layouts.push(descriptor); return descriptor as unknown as GPUBindGroupLayout; }),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => {
      pipelineLayouts.push(descriptor); return descriptor as unknown as GPUPipelineLayout;
    }),
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
      descriptors.push(descriptor); return { descriptor } as unknown as GPURenderPipeline;
    }),
  };
  return { device: device as unknown as GPUDevice, descriptors, layouts, pipelineLayouts };
}

it("binds output provenance to the exact module code and output pipeline", async () => {
  const f = fixture();
  const result = await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout);
  const submitted = vi.mocked(f.device.createShaderModule).mock.calls.find(([descriptor]) => descriptor.label === "Deep HDR output")![0];
  const refs = result.outputShaderProvenance!.refsFor(result.output);
  expect(refs.map(ref => ref.moduleId)).toEqual(Array(2).fill(`builtin.pbr-output.sha256-${sha256Utf8(submitted.code)}`));
  expect(() => result.outputShaderProvenance!.refsFor(result.main)).toThrow("executed pipeline");
});

it("shares the device-local HDR output pipeline across static and deformation variants", async () => {
  const f = fixture(), lighting = {} as GPUBindGroupLayout;
  const [staticSet, deformationSet] = await Promise.all([
    createPipelines(f.device, "bgra8unorm", lighting),
    createPipelines(f.device, "bgra8unorm", lighting, true, false, false, { deformation: true }),
  ]);
  expect(staticSet.output).toBe(deformationSet.output);
  expect(f.descriptors.filter(descriptor => descriptor.label === "Deep output")).toHaveLength(1);
  expect(vi.mocked(f.device.createShaderModule).mock.calls.filter(([descriptor]) =>
    descriptor.label === "Deep HDR output")).toHaveLength(1);
  expect(deformationSet.outputShaderProvenance!.refsFor(deformationSet.output)).toHaveLength(2);
});

it("builds deformation variants for all main and shadow modes without a fourth vertex stream", async () => {
  const f = fixture();
  const result = await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout, true, false, true, { deformation: true });
  expect(result.deformationPlainLayout).toBeDefined();
  // AA-M2:MSAA4 缺省档 depth 变体 × a2c(2) = 27 条 main(18 普通 + 9 a2c)。
  expect(result.mainPipelines.size).toBe(27);
  expect(result.shadowPipelines.size).toBe(18);
  for (const descriptor of f.descriptors.filter(item => item.label?.startsWith("Deep forward"))) {
    expect(descriptor.vertex.entryPoint).toMatch(/^vertexDeformed/);
    expect([...descriptor.vertex.buffers!]).toHaveLength(3);
  }
  for (const descriptor of f.descriptors.filter(item => item.label?.startsWith("Deep shadow"))) {
    expect(descriptor.vertex.entryPoint).toMatch(/^shadow(Mask)?Deformed$/);
  }
  const poseLayouts = f.layouts.filter(layout => [...layout.entries].some(entry => entry.binding === 11 && entry.buffer?.type === "read-only-storage"));
  expect(poseLayouts).toHaveLength(2);
  for (const layout of poseLayouts) expect([...layout.entries].filter(entry => entry.binding >= 11)).toEqual([
    { binding: 11, visibility: 1, buffer: { type: "read-only-storage", minBindingSize: 48 } },
    { binding: 12, visibility: 1, buffer: { type: "read-only-storage", minBindingSize: 48 } },
  ]);
});

it("rejects a deformation direct-display path before allocating pipelines", async () => {
  const f = fixture();
  await expect(createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout, false, false, false,
    { deformation: true })).rejects.toThrow("geometry buffers");
  expect(f.layouts).toHaveLength(0);
});

it("keeps default raster bias while providing isolated unbiased author variants", async () => {
  const f = fixture();
  await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout, true, false, true);
  const authored = f.descriptors.filter(d => d.label?.startsWith("Deep shadow author/"));
  expect(authored).toHaveLength(9);
  authored.forEach(d => expect(d.depthStencil).toMatchObject({ depthBias: 0, depthBiasSlopeScale: 0 }));
  authored.forEach(d => expect(d.primitive?.cullMode).toBe(d.label?.endsWith("/double") ? "none" : "front"));
  const ordinary = f.descriptors.filter(d => d.label?.startsWith("Deep shadow ") && !d.label?.includes("author/"));
  expect(ordinary).toHaveLength(9);
  ordinary.forEach(d => expect(d.depthStencil).toMatchObject({ depthBias: 1, depthBiasSlopeScale: 1 }));
  ordinary.forEach(d => expect(d.primitive?.cullMode).toBe(d.label?.endsWith("/double") ? "none" : "back"));
});

describe("PBR pipeline texture variants", () => {
  it("bounds material variants while separating transparent depth/blend and masked shadows", async () => {
    const f = fixture(), result = await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout);
    // AA-M1 采样数合同(置于易随并行任务变动的管线计数断言之前,单独可判):
    // HDR 主管线 4x;阴影管线无多采样(1x 图集;直出 display 见下方 color-only 用例)。
    expect(f.descriptors[0]!.multisample?.count).toBe(4);
    const forward = f.descriptors.filter(descriptor => descriptor.label?.startsWith("Deep forward PBR "));
    const shadows = f.descriptors.filter(descriptor => descriptor.label?.startsWith("Deep shadow "));
    // AA-M2:MSAA4 档 depth 变体 × a2c → main 27 条;阴影仍 9 条(1x 图集,a2c 不适用)。
    expect(forward).toHaveLength(27);
    expect(shadows[0]!.multisample).toBeUndefined();
    expect(shadows[3]!.multisample).toBeUndefined();
    // B1 Brief-VSM:+3 页物化管线(solid×3 raster)+ 1 页清屏管线(pageShadowPipelines)。
    expect(f.descriptors).toHaveLength(41);
    expect(result.mainPipelines.size).toBe(27); expect(result.shadowPipelines.size).toBe(9);
    expect(result.pageShadowPipelines.size).toBe(4);
    // depth 变体按 (mode, raster) 各 2 条(普通 + a2c,entryPoint 相同);blend 变体各 1 条。
    const depthVariants = forward.filter(value => value.label!.includes("/depth/"));
    const blendVariants = forward.filter(value => value.label!.includes("/blend/"));
    const depthEntryPoints = [...Array(3).fill("fragmentMain"), ...Array(6).fill("fragmentMaterial")];
    expect(depthVariants.filter(value => !value.label!.endsWith("/a2c")).map(value => value.fragment?.entryPoint))
      .toEqual(depthEntryPoints);
    expect(depthVariants.filter(value => value.label!.endsWith("/a2c")).map(value => value.fragment?.entryPoint))
      .toEqual(depthEntryPoints);
    expect(blendVariants.map(value => value.fragment?.entryPoint)).toEqual([
      ...Array(3).fill("fragmentMainTransparent"), ...Array(6).fill("fragmentMaterialTransparent"),
    ]);
    expect(result.mainPipelines.get("plain/blend/ccw")).toBeDefined();
    expect(result.mainPipelines.has("plain/blend/ccw/a2c")).toBe(false);
    const vertex = f.descriptors[0]!.vertex.buffers![0]!;
    expect(vertex.arrayStride).toBe(40);
    expect(vertex.attributes).toContainEqual({ shaderLocation: 10, offset: 24, format: "float32x4" });
    expect(f.descriptors[0]!.vertex.buffers![1]).toMatchObject({ arrayStride: 144,
      attributes: expect.arrayContaining([{ shaderLocation: 12, offset: 128, format: "float32x4" }]) });
    expect(f.descriptors[0]!.vertex.buffers![2]).toEqual(PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT);
    // AA-M2:normal 模式 depth 变体起点移到 18(plain 6+3、material 6+3 之后)。
    expect(f.descriptors[18]!.vertex.entryPoint).toBe("vertexNormalMapped");
    expect(f.descriptors[18]!.vertex.buffers![3]).toEqual({ arrayStride: 16,
      attributes: [{ shaderLocation: 11, offset: 0, format: "float32x4" }] });
    expect(f.descriptors[0]!.primitive?.cullMode).toBe("back");
    // double raster 的 depth 变体现在位于 4(0 ccw、1 ccw/a2c、2 cw、3 cw/a2c、4 double)。
    expect(f.descriptors[4]!.primitive?.cullMode).toBe("none");
    // blend 变体在 plain depth(6 条)之后从 6 开始;仍为 OIT 双目标、无深度写。
    expect(f.descriptors[6]!.depthStencil?.depthWriteEnabled).toBe(false);
    expect(f.descriptors[0]!.fragment!.targets.map(target => target!.format)).toEqual([
      "rgba16float", "r32float", "rgba8unorm", "rg16float",
    ]);
    expect(f.descriptors[6]!.fragment!.targets).toHaveLength(2);
    expect(f.descriptors[6]!.fragment!.targets.map(target => target!.format)).toEqual(["rgba16float", "r16float"]);
    expect(f.descriptors[6]!.fragment!.targets[0]!.blend).toEqual({
      color: { operation: "add", srcFactor: "one", dstFactor: "one" },
      alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
    });
    // 阴影区起点随 main 27 条移到 27:solid×3、maskPlain×3、maskMaterial×3。
    expect(f.descriptors[29]!.primitive?.cullMode).toBe("none");
    expect(f.descriptors[30]!.fragment?.entryPoint).toBe("shadowMaskPlain");
    expect(f.descriptors[33]!.fragment?.entryPoint).toBe("shadowMaskTextured");
    expect(f.descriptors[27]!.vertex.buffers?.map(buffer => buffer.attributes.map(attribute => attribute.shaderLocation)))
      .toEqual([[0], [2, 3, 4]]);
    expect(f.descriptors[30]!.vertex.buffers?.map(buffer => buffer.attributes.map(attribute => attribute.shaderLocation)))
      .toEqual([[0, 10], [2, 3, 4, 9, 12]]);
    expect(f.layouts[1]!.entries.map(entry => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(f.layouts[3]).toMatchObject({ label: "Deep cascaded shadow group 2", entries: [
      { binding: 0, buffer: { type: "uniform", minBindingSize: CASCADED_SHADOW_UNIFORM_BYTES } },
      { binding: 1, texture: { sampleType: "depth", viewDimension: "2d-array" } },
      { binding: 2, sampler: { type: "comparison" } },
    ] });
    expect(Array.from(f.pipelineLayouts[0]!.bindGroupLayouts)[2]).toBe(f.layouts[3]);
    expect(Array.from(f.pipelineLayouts[1]!.bindGroupLayouts)[2]).toBe(f.layouts[3]);
    expect(f.layouts[0]!.entries[0]!.buffer?.minBindingSize).toBe(PBR_FRAME_UNIFORM_BYTES);
    expect(f.layouts[0]!.entries.find(entry => entry.binding === 8)).toEqual({
      binding: 8, visibility: 2, buffer: { type: "uniform", minBindingSize: 32 },
    });
    // B1 Brief-VSM:虚拟页表/atlas 折入 group 0(frameLayout 12/13/14)——布局组数不变。
    expect(f.pipelineLayouts.slice(0, 2).map(layout => Array.from(layout.bindGroupLayouts).length)).toEqual([4, 4]);
    expect(Array.from(f.pipelineLayouts[0]!.bindGroupLayouts)[3]).toEqual({});
    expect(Array.from(f.pipelineLayouts[2]!.bindGroupLayouts)).toEqual([f.layouts[0], f.layouts[2], f.layouts[3]]);
    expect(PBR_FRAME_UNIFORM_BYTES).toBe(384);
    expect(PBR_FRAME_FLOAT_OFFSETS).toEqual({ currentViewProjection: 0, previousViewProjection: 16, worldToView: 32,
      lightViewProjection: 48, eye: 64, background: 68, floor: 72, lightDirection: 76, tuning: 80, sunColor: 84,
      output: 88 });
    expect(PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT).toMatchObject({ arrayStride: 48, stepMode: "instance",
      attributes: [{ shaderLocation: 13, offset: 0 }, { shaderLocation: 14, offset: 16 }, { shaderLocation: 15, offset: 32 }] });
  });

  it("rejects shader compilation errors before allocating pipelines", async () => {
    const error = { type: "error", lineNum: 17, message: "bad shader" } as GPUCompilationMessage;
    const f = fixture([error]);
    await expect(createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout)).rejects.toThrow("WGSL 17: bad shader");
    expect(f.descriptors).toHaveLength(0);
  });

  it("uses color-only opaque pipelines when geometry buffers have no consumer", async () => {
    const f = fixture();
    const result = await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout, false);
    // AA-M2:main depth 变体 ×a2c(27 条)在前,display 直出 9 条随后。
    const opaque = f.descriptors.slice(0, 27).filter(value => value.label!.includes("/depth/"));
    expect(opaque.every(value => value.fragment?.targets.length === 1)).toBe(true);
    expect(opaque.filter(value => !value.label!.endsWith("/a2c")).map(value => value.fragment?.entryPoint)).toEqual([
      ...Array(3).fill("fragmentMainColor"),
      ...Array(6).fill("fragmentMaterialColor"),
    ]);
    expect(result.displayPipelines.size).toBe(9);
    expect(f.descriptors.slice(27, 36).map(value => value.fragment?.entryPoint)).toEqual([
      ...Array(3).fill("fragmentMainDisplay"), ...Array(6).fill("fragmentMaterialDisplay"),
    ]);
    expect(f.descriptors[27]!.vertex).toMatchObject({ entryPoint: "vertexDirectDisplay", buffers: { length: 2 } });
    expect(f.descriptors[30]!.vertex).toMatchObject({ entryPoint: "vertexMaterialDirectDisplay", buffers: { length: 2 } });
    expect(f.descriptors[33]!.vertex).toMatchObject({ entryPoint: "vertexNormalMaterialDirectDisplay", buffers: { length: 3 } });
    // AA-M1:直出 display 管线渲染进 1x swapchain,恒不参与 MSAA。
    expect(f.descriptors.slice(27, 36).every(value => value.multisample?.count === 1)).toBe(true);
    expect(f.descriptors.slice(27, 36).every(value => value.fragment?.targets[0]?.format === "bgra8unorm")).toBe(true);
  });

  it("specializes the plain display shader when static visual effects are disabled", async () => {
    const f = fixture();
    const result = await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout, false, true, true);
    expect(f.descriptors[27]!.fragment?.entryPoint).toBe("fragmentMainDisplayNoEffectsOneCascade");
    expect(f.descriptors[30]!.fragment?.entryPoint).toBe("fragmentMaterialDisplay");
    expect(result.displayDirectionalPipelines.size).toBe(3);
    expect(result.displayDirectionalMain).toBeDefined();
  });

  it("builds alphaToCoverageEnabled variants only for the multisampled main depth set (AA-M2)", async () => {
    const f = fixture();
    const result = await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout);
    const a2c = result.mainPipelines.get("material/depth/ccw/a2c");
    expect(a2c).toBeDefined();
    const descriptor = f.descriptors.find(value => value.label === "Deep forward PBR material/depth/ccw/a2c")!;
    // a2c 仅作用于 target0(G-buffer color / HDR color);其余 G-buffer 附件语义不变。
    expect(descriptor.fragment!.targets[0]!.alphaToCoverageEnabled).toBe(true);
    expect(descriptor.fragment!.targets.slice(1).every(target => !target.alphaToCoverageEnabled)).toBe(true);
    expect(descriptor.multisample!.count).toBe(4);
    // 透明(OIT)与 1x 档不建 a2c;阴影/直出 display 集合无 a2c key。
    expect(result.mainPipelines.has("material/blend/ccw/a2c")).toBe(false);
    expect(result.shadowPipelines.has("maskMaterial/ccw/a2c")).toBe(false);
    expect(result.displayPipelines.get("material/depth/ccw/a2c")).toBeUndefined();
    const plainA2c = f.descriptors.find(value => value.label === "Deep forward PBR plain/depth/ccw/a2c")!;
    expect(plainA2c.fragment!.targets[0]!.alphaToCoverageEnabled).toBe(true);
    expect(result.mainPipelines.get("normal/depth/double/a2c")).toBeDefined();
  });

  it("omits a2c variants entirely in the 1x pipeline set (fail-closed draw-time error)", async () => {
    const f = fixture();
    const result = await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout, true, false, false, { mainSampleCount: 1 });
    expect(result.mainPipelines.size).toBe(18);
    expect(result.mainPipelines.has("plain/depth/ccw/a2c")).toBe(false);
    expect(f.descriptors.every(value => !value.fragment?.targets[0]?.alphaToCoverageEnabled)).toBe(true);
  });
});

describe("first-frame critical pipeline subset", () => {
  it("queues only critical mains before the bootstrap scope is released", async () => {
    const f = fixture();
    const build = await createPipelinesBuild(f.device, "bgra8unorm", {} as GPUBindGroupLayout, true, false, false,
      { firstFrameMainKeys: ["material/depth/ccw"] });
    expect(build.pipelines.mainPipelines.size).toBe(2);
    expect(build.pipelines.main).toBeDefined();
    expect(f.descriptors.filter(descriptor => descriptor.label?.startsWith("Deep forward"))).toHaveLength(2);
    // 分级重上(双前置已清):subset 路径 release 前 shadow 仅 solid×3(critical);
    // mask 两档+authored 变体(此场景 authored 关 = 6 条)release 后同流补齐。
    expect(build.pipelines.shadowPipelines.size).toBe(3);
    // 分级重上前置②:subset 路径(外部 release 承诺)release 前页管线零创建,
    // validate 提前不再与 pending 创建形成 popErrorScope 并发窗口。
    expect(build.pipelines.pageShadowPipelines.size).toBe(0);
    await build.criticalReady;
    build.releaseDeferredQueues();
    await build.ready;
    // AA-M2:MSAA4 档 depth ×a2c → 27 条 main。
    expect(build.pipelines.mainPipelines.size).toBe(27);
    expect(build.pipelines.mainPipelines.get("material/blend/ccw")).toBeDefined();
    // release 后非虚拟档页管线(clear+solid×3)补齐;shadow 集回到 9,
    // mask batch 就绪前经 solid 回退(就绪后按 key 恢复逐像素掩码)。
    expect(build.pipelines.pageShadowPipelines.size).toBe(4);
    expect(build.pipelines.shadowPipelines.size).toBe(9);
    expect(build.pipelines.shadowPipelines.get("maskPlain/ccw")).toBeDefined();
    expect(build.pipelines.shadowPipelines.get("maskMaterial/double")).toBeDefined();
  });

  it("keeps the full critical path when no subset is requested", async () => {
    const f = fixture();
    const build = await createPipelinesBuild(f.device, "bgra8unorm", {} as GPUBindGroupLayout, true, false, false);
    await build.criticalReady;
    await build.ready;
    expect(build.pipelines.mainPipelines.size).toBe(27);
    expect(build.pipelines.shadowPipelines.size).toBe(9);
  });

  it("keeps the virtual shadow library out of the default module and in the virtualShadowPages module (B1 variant)", async () => {
    const f = fixture();
    await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout);
    const moduleCode = vi.mocked(f.device.createShaderModule).mock.calls
      .find(([descriptor]) => descriptor.label === "Deep PBR")![0].code as string;
    // 默认(级联)档:VSM 采样库 + params2.x 门行剥离(首帧编译墙第二刀)。
    expect(moduleCode).not.toContain("deepVirtualShadow");
    expect(moduleCode).not.toContain("deepVsmMeta");
    // 虚拟档:库与门行保留(与变体化前历史全量文本同族)。
    const v = fixture();
    await createPipelines(v.device, "bgra8unorm", {} as GPUBindGroupLayout, true, false, false,
      { virtualShadowPages: true });
    const virtualCode = vi.mocked(v.device.createShaderModule).mock.calls
      .find(([descriptor]) => descriptor.label === "Deep PBR")![0].code as string;
    expect(virtualCode).toContain("deepVirtualShadow");
    expect(virtualCode).toContain("@group(0) @binding(12) var<storage, read> deepVsmMeta : array<vec4u>;");
    expect(virtualCode.length).toBeGreaterThan(moduleCode.length);
  });
});
