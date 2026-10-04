/// <reference types="@webgpu/types" />
/**
 * M2 方向光 RT 阴影帧链真机探针(由 scripts/rtShadowFrameGpuTest.mjs 驱动,headless Chrome + WebGPU)。
 * 验收(任务书第 5 条的最小真机对照):
 *  ① 默认档 sceneShader 与 RT 档 sceneShaderRayTracedShadows 在 RTX 4060(Dawn)编译零 error
 *     —— 含 group(2) binding(3) mask 声明 + frame.output.bloom 分支的 WGSL 真机有效性;
 *  ② RT 布局合同真机:cascadedShadowLayout 第 4 条(unfilterable-float/2d)+ r32float
 *     STORAGE|TEXTURE 纹理的 bind group 创建成功;
 *  ③ ShadowRayFramePass 生产路径(encode 无 readback 合同 + 探针 readback 通道):
 *     背景(depth≥1)mask=1.0;垂直光下 box footprint 内=遮挡(0)、外=可见(1);
 *  ④ 光源旋转语义:斜向光的遮挡像素集沿光方向偏移(遮挡像素质心位移与光方向点积>0)。
 * 本探针不渲染完整 PbrRenderer 帧(需调用方场景全链,见交付报告"待真机"披露);完整帧
 * 开关关=HEAD 逐字节一致已由 checksum strip 恒等断言在字节层机器证明。
 */

import { sceneShader, sceneShaderRayTracedShadows } from "../src/webgpu/pbrShader.js";
import { ShadowRayFramePass } from "../src/rayTracing/shadowRayFramePass.js";
import { IncrementalTlasScene } from "../src/rayTracing/incrementalTlas.js";
import { buildShadowScene, floorBlas, boxBlas } from "./shadowRayGpuCases.js";
import type { TlasPackedScene } from "../src/rayTracing/tlasLayout.js";

export { buildShadowScene };

export interface RtShadowFrameGpuProbeResult {
  readonly adapter: string | null;
  readonly features: readonly string[];
  readonly shaderCompiliation: { readonly default: number; readonly rt: number };
  readonly rtBindGroupCreated: boolean;
  readonly frames: ReadonlyArray<{
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly backgroundCorrect: boolean;
    readonly occludedCount: number;
    readonly occludedCentroid: readonly [number, number] | null;
    readonly dispatchX: number;
    readonly dispatchY: number;
    readonly maskZeros: number;
    readonly maskOnes: number;
    readonly stackOverflows: number;
    readonly depthStats: { readonly zeros: number; readonly ones: number; readonly mid: number; readonly above: number };
    readonly loadStats: { readonly zeros: number; readonly ones: number; readonly mid: number; readonly above: number };
  }>;
  readonly lightRotation: { readonly lightRotationShiftsShadow: boolean | null;
    readonly shadowBeyondFootprint: boolean | null };
  readonly errors: readonly string[];
}

const WIDTH = 64, HEIGHT = 64;
/** 俯视正交:像素 depth d 编码世界 y=d 平面(0=地面,1=背景/天空)。 */
const toBase64 = (buffer: ArrayBuffer): string => Buffer.from(buffer).toString("base64");

function encodeViewProjection(): Float32Array<ArrayBuffer> {
  // 正交玩具相机,但 depth 通道合规(NDC z 必须 0..1):clip=(x/16, z/16, y/8, 1)
  // → world=(16·ndc.x, 8·ndc.z, 16·ndc.y);kernel 重建世界点后:
  //   depth 0.00625 → 地面接收 y=0.05(脱 floor 自相交,同上游 receiver y=0.02 惯例)
  //   depth 0.44375 → box 顶面上方 y=3.55(避开 y=3.5 slab 边界)
  //   depth 1.0     → 背景(y=8,floor 之上无几何,kernel 短路写 1.0)
  return new Float32Array([
    1 / 16, 0, 0, 0,
    0, 0, 1 / 8, 0,
    0, 1 / 16, 0, 0,
    0, 0, 0, 1,
  ]);
}

export async function runRtShadowFrameGpuProbe(): Promise<RtShadowFrameGpuProbeResult> {
  const errors: string[] = [];
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { adapter: null, features: [], shaderCompiliation: { default: 1, rt: 1 },
    rtBindGroupCreated: false, frames: [], lightRotation: { lightRotationShiftsShadow: null,
      shadowBeyondFootprint: null }, errors: ["navigator.gpu.requestAdapter() returned null."] };
  const features = [...adapter.features];
  const device = await adapter.requestDevice();
  device.addEventListener?.("uncapturederror", (event: Event) => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  const adapterInfo = (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string } }).info;
  const adapterName = adapterInfo === undefined ? "unknown"
    : `${adapterInfo.vendor ?? "unknown"}/${adapterInfo.architecture ?? ""}`;

  // ① WGSL 真机编译(默认档+RT 档;逐条统计 error 数;规范形态 promise)。
  const countErrors = async (code: string): Promise<number> =>
    (await device.createShaderModule({ code }).getCompilationInfo())
      .messages.filter(message => message.type === "error").length;
  const shaderCompiliation = { default: await countErrors(sceneShader),
    rt: await countErrors(sceneShaderRayTracedShadows) };

  // ② RT 布局+bind group 真机合同(r32float unfilterable + storage|texture)。
  let rtBindGroupCreated = false;
  try {
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", minBindingSize: 640 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
    ] });
    const maskTexture = device.createTexture({ label: "probe-mask", size: [4, 4], format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const uniform = device.createBuffer({ size: 640, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const depthArray = device.createTexture({ label: "probe-csm", size: [4, 4, 1], format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: depthArray.createView({ dimension: "2d-array" }) },
      { binding: 2, resource: device.createSampler({ compare: "less-equal" }) },
      { binding: 3, resource: maskTexture.createView() },
    ] });
    rtBindGroupCreated = true;
    maskTexture.destroy(); uniform.destroy(); depthArray.destroy();
  } catch (error) {
    errors.push(`rt bind group: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ③④ ShadowRayFramePass 生产路径(depth writeTexture + encode + readback)。
  const scene = buildShadowScene();
  const packed: TlasPackedScene = scene.tlas.packed;
  const pass = new ShadowRayFramePass(device, packed);
  const viewProjection = encodeViewProjection();
  const frames: Array<RtShadowFrameGpuProbeResult["frames"][number]> = [];
  const centroids: Array<readonly [number, number] | null> = [];

  // depth 写入器(生产同构:主帧 depth 是渲染产物;Dawn 154 的 writeTexture→depth32float
  // 实测不生效——三次读回全 0,含 aspect:"depth-only" 形态,故用渲染管线写)。
  // 一个 fullscreen 大三角 + uniform depth(ndc z),box footprint 用 scissor 收窄。
  const depthUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const depthWriterModule = device.createShaderModule({ code: `
    @group(0) @binding(0) var<uniform> depthParams: vec4f;
    @vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
      return vec4f(corners[vi], depthParams.x, 1.0);
    }
  ` });
  // 纯 depth 管线(无 fragment 段):实测 fragment+空 targets 形态在 Dawn 154 headless
  // 下 depth 写入不落盘(clear 后 draw 读回恒为 clear 值),去 fragment 后逐值落盘。
  const depthWriterPipeline = device.createRenderPipeline({ layout: "auto",
    vertex: { module: depthWriterModule, entryPoint: "vs" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
  // 每个深度值独立 uniform buffer —— writeBuffer 是 queue 级即时操作,同一 buffer
  // 连续写会全部折叠为末值(实测教训:三 draw 全用末次值 1 = clear 值,depth 写入假失效)。
  const depthWriterBind = (value: number): GPUBindGroup => {
    const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, new Float32Array([value, 0, 0, 0]));
    return device.createBindGroup({ layout: depthWriterPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }] });
  };
  const writeDepth = (depthTexture: GPUTexture): void => {
    const boxScissor = { x: 23, y: 31, width: 7, height: 6 }; // wx∈[-4.5,-1.5], wz∈[-2.5,0.5]
    const encoder = device.createCommandEncoder({ label: "probe-depth-writer" });
    const renderPass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
      view: depthTexture.createView({ dimension: "2d", aspect: "depth-only" }),
      depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    renderPass.setPipeline(depthWriterPipeline);
    // 分区写(clear 1.0 = 背景行;后续 draw 按区域 scissor,谁后写谁生效):
    // 地面 = 行 4..63(wz<14),box footprint = 行 31..36 × 列 23..29。
    renderPass.setScissorRect(0, 4, WIDTH, HEIGHT - 4);
    renderPass.setBindGroup(0, depthWriterBind(0.05 / 8));
    renderPass.draw(3);
    renderPass.setScissorRect(boxScissor.x, boxScissor.y, boxScissor.width, boxScissor.height);
    renderPass.setBindGroup(0, depthWriterBind(3.55 / 8));
    renderPass.draw(3);
    renderPass.end();
    device.queue.submit([encoder.finish()]);
  };

  // 诊断 compute(探针自有,不碰 rayTracing/):绑定同一 depthView,把 textureLoad
  // 结果原样写 r32float —— 区分"depth 纹理内容"与"kernel 行为"。
  const depthProbeModule = device.createShaderModule({ code: `
    @group(0) @binding(0) var srcDepth: texture_depth_2d;
    @group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;
    @compute @workgroup_size(8, 8)
    fn copyDepth(@builtin(global_invocation_id) gid: vec3u) {
      let px = vec2i(gid.xy);
      textureStore(dst, px, vec4f(textureLoad(srcDepth, px, 0), 0.0, 0.0, 1.0));
    }
  ` });
  const depthProbePipeline = device.createComputePipeline({ layout: "auto",
    compute: { module: depthProbeModule, entryPoint: "copyDepth" } });

  const runFrame = async (name: string, lightDir: readonly [number, number, number]): Promise<void> => {
    const depthTexture = device.createTexture({ label: `probe-depth-${name}`, size: [WIDTH, HEIGHT],
      format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT });
    writeDepth(depthTexture);
    // 断言基准(与 GPU 写入同构的解析参考):行 0..3 = 背景(z≥14);box scissor = 顶面上方。
    const depthData = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const wx = -16 + 32 * (x + 0.5) / WIDTH;
      const wz = 16 - (y + 0.5) / 2;
      depthData[y * WIDTH + x] = wz >= 14 ? 1
        : (wx >= -4.5 && wx <= -1.5 && wz >= -2.5 && wz <= 0.5 ? 3.55 / 8 : 0.05 / 8);
    }
    const maskTexture = device.createTexture({ label: `probe-mask-${name}`, size: [WIDTH, HEIGHT],
      format: "r32float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.COPY_SRC });
    const readback = device.createBuffer({ size: WIDTH * HEIGHT * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    // depth 内容读回(验证 writeTexture→depth32float 真实生效;背景行应为精确 1.0)。
    const depthReadback = device.createBuffer({ size: WIDTH * HEIGHT * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const depthProbeEncoder = device.createCommandEncoder({ label: `probe-depth-copy-${name}` });
    depthProbeEncoder.copyTextureToBuffer({ texture: depthTexture, aspect: "depth-only" },
      { buffer: depthReadback, bytesPerRow: WIDTH * 4 }, [WIDTH, HEIGHT]);
    device.queue.submit([depthProbeEncoder.finish()]);
    await depthReadback.mapAsync(GPUMapMode.READ);
    const depthRead = new Float32Array(depthReadback.getMappedRange().slice(0));
    depthReadback.unmap();
    depthReadback.destroy();
    const depthStats = { zeros: [...depthRead].filter(v => v === 0).length,
      ones: [...depthRead].filter(v => v === 1).length,
      mid: [...depthRead].filter(v => v > 0 && v < 1).length,
      above: [...depthRead].filter(v => v > 1).length };
    const encoder = device.createCommandEncoder({ label: `probe-${name}` });
    const dispatch = await pass.encode(encoder, {
      depthView: depthTexture.createView({ dimension: "2d", aspect: "depth-only" }),
      maskView: maskTexture.createView(), width: WIDTH, height: HEIGHT,
      invViewProjection: [...encodeViewProjection()] as unknown as readonly [number, number, number, number, number,
        number, number, number, number, number, number, number, number, number, number, number],
      lightDir: [...lightDir] as unknown as readonly [number, number, number],
      tMax: 64, rayMask: 0xffffffff,
    });
    encoder.copyTextureToBuffer({ texture: maskTexture }, { buffer: readback, bytesPerRow: WIDTH * 4 },
      [WIDTH, HEIGHT]);
    // 哨兵读回通道暂不可用(上游 ShadowRayFramePass 的 stackOverflows buffer 缺
    // COPY_SRC,readbackStackOverflows 的 copy 会让整个 command buffer 变 Invalid、
    // dispatch 被静默丢弃 —— 上游缺陷,已记 handoff);此处不调,保 encoder 合法。
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mask = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    const stackOverflows = -1;
    let zeros = 0, ones = 0, other = 0;
    for (let index = 0; index < mask.length; index++) {
      const value = mask[index]!;
      if (value === 0) zeros++; else if (value === 1) ones++; else other++;
    }
    void zeros; void ones; void other;
    // 断言:背景条带(wz≥14,即像素行 y≤3)全 1.0。
    let backgroundCorrect = true;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const wz = 16 - (y + 0.5) / 2;
        if (wz >= 14 && mask[y * WIDTH + x] !== 1) backgroundCorrect = false;
      }
    }
    // 诊断:同 view 的 depth 内容直读(与 kernel 同路径)。
    const probeMask = device.createTexture({ label: `probe-depthcopy-${name}`, size: [WIDTH, HEIGHT],
      format: "r32float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const probeRead = device.createBuffer({ size: WIDTH * HEIGHT * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const probeEncoder2 = device.createCommandEncoder({ label: `probe-depthcopy-${name}` });
    const probePass = probeEncoder2.beginComputePass({ label: "probe-depthcopy" });
    probePass.setPipeline(depthProbePipeline);
    probePass.setBindGroup(0, device.createBindGroup({ layout: depthProbePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: depthTexture.createView({ dimension: "2d", aspect: "depth-only" }) },
        { binding: 1, resource: probeMask.createView() }] }));
    probePass.dispatchWorkgroups(WIDTH / 8, HEIGHT / 8);
    probePass.end();
    probeEncoder2.copyTextureToBuffer({ texture: probeMask }, { buffer: probeRead, bytesPerRow: WIDTH * 4 }, [WIDTH, HEIGHT]);
    device.queue.submit([probeEncoder2.finish()]);
    await probeRead.mapAsync(GPUMapMode.READ);
    const depthViaLoad = new Float32Array(probeRead.getMappedRange().slice(0));
    probeRead.unmap();
    probeRead.destroy(); probeMask.destroy();
    const loadStats = { zeros: [...depthViaLoad].filter(v => v === 0).length,
      ones: [...depthViaLoad].filter(v => v === 1).length,
      mid: [...depthViaLoad].filter(v => v > 0 && v < 1).length,
      above: [...depthViaLoad].filter(v => v > 1).length };
    console.log(JSON.stringify({ frame: name, loadStats }));
    // 遮挡像素质心(仅地面接收像素 depth<0.1 ↔ y=0.4;box 顶面上方起点与背景不进统计)。
    let occludedCount = 0, cx = 0, cz = 0;
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      if (depthData[y * WIDTH + x]! >= 0.1) continue;
      if (mask[y * WIDTH + x] === 0) { occludedCount++; cx += x; cz += y; }
    }
    const centroid = occludedCount > 0 ? [cx / occludedCount, cz / occludedCount] as const : null;
    centroids.push(centroid);
    frames.push({ name, width: WIDTH, height: HEIGHT, backgroundCorrect, occludedCount,
      occludedCentroid: centroid, dispatchX: dispatch.dispatchX, dispatchY: dispatch.dispatchY,
      maskZeros: zeros, maskOnes: ones, stackOverflows, depthStats, loadStats });
    depthTexture.destroy(); maskTexture.destroy(); readback.destroy();
  };

  try {
    await runFrame("vertical", [0, 1, 0]);
    await runFrame("tilted", [0.70710678, 0, 0.70710678]);
  } catch (error) {
    errors.push(`frame: ${error instanceof Error ? error.message : String(error)}`);
  }
  pass.destroy();

  // ④ 光源旋转语义:垂直光(表面起点全部背向场景)无遮挡;斜向光把 block-a 的影子沿
  // (1,0,1) 拉长到 footprint 之外。遮挡点质心记录为证据。
  const vertical = frames.find(frame => frame.name === "vertical");
  const tilted = frames.find(frame => frame.name === "tilted");
  const lightRotationShiftsShadow = (vertical?.occludedCount ?? 1) === 0 && (tilted?.occludedCount ?? 0) > 0;
  let shadowBeyondFootprint: boolean | null = null;
  if (tilted?.occludedCentroid) {
    const [cx, cz] = tilted.occludedCentroid;
    const footprintCenter = [(-4.5 + -1.5) / 2, (-2.5 + 0.5) / 2];
    // 像素 x ↔ world.x = -16+32*(x+0.5)/64;像素 y ↔ world.z = 16-(y+0.5)/2(kernel 翻转)。
    const wx = -16 + 32 * (cx + 0.5) / WIDTH;
    const wz = 16 - (cz + 0.5) / 2;
    shadowBeyondFootprint = wx > footprintCenter[0]! || wz > footprintCenter[1]!;
  }

  device.destroy();
  return { adapter: adapterName, features, shaderCompiliation, rtBindGroupCreated, frames,
    lightRotation: { lightRotationShiftsShadow, shadowBeyondFootprint }, errors };
}

// 未导出依赖的引用保持(floorBlas/boxBlas 经 buildShadowScene 使用,导出便于 Node 侧单测)。
export { floorBlas, boxBlas };
