import { EVALUATION_LIGHT_HEIGHT, buildEvaluationLights, planAtlasLeg, planPagedLeg, analyticSpotVisibility,
  spotIrradiance,
  summarizeShadowQuality, EVALUATION_BUDGET_BYTES, type AtlasLegOptions, type EvaluationSpotLight,
  type LegPlan, type PagedLegOptions, type ShadowQualityStats } from "../src/shadows/shadowPagingEvaluation.js";
import { aggregateShadowStats, type LegEvaluation, type PerLightQuality } from "./shadowPagingQualityGpuScene.js";
import { lookAt, multiply, perspective } from "../src/webgpu/cameraMath.js";
import { CAMERA, FRAME_UNIFORM_FLOATS, HEIGHT, LEG_CONFIGS, LIGHT_COUNTS, MEASURE_FRAMES,
  RECEIVER_WGSL, SHADOW_WGSL, WARM_FRAMES, WIDTH, cameraBasis, cameraRay, decodeHalfFloat,
  emitBoxes, patchRect } from "./shadowPagingQualityGpuScene.js";

/**
 * F7 虚拟化阴影画质真机探针(headless Chrome WebGPU,beginLeg/stepLeg/endLeg 形态同
 * clearcoatFurnaceGpuProbe)。独立 mini-renderer,不触碰产品渲染器:
 * 同一场景(N 个直下式 spot 灯各照一块地板补丁,每补丁 3 根竖条遮挡器)按两条腿的
 * granted 分辨率各渲一遍——atlas 腿(现行全有/全无图集)与 paged 腿(mip 页表)。
 * 画质 = 读回像素按未遮挡辐照度归一后对照 CPU 解析硬影(RMSE/渗漏/边宽);
 * 性能 = 帧级 wall delta(提交→onSubmittedWorkDone,F1 帧级口径)+ CPU 策略层 p50。
 * 场景几何/WGSL/相机常量见 shadowPagingQualityGpuScene.ts。
 */

export { LEG_CONFIGS, LIGHT_COUNTS, aggregateShadowStats } from "./shadowPagingQualityGpuScene.js";
export type { LegEvaluation, PerLightQuality } from "./shadowPagingQualityGpuScene.js";
export const SHADOW_PAGING_PROBE_CONSTANTS = Object.freeze({ WIDTH, HEIGHT, WARM_FRAMES, MEASURE_FRAMES,
  BUDGET_BYTES: EVALUATION_BUDGET_BYTES });

interface ActiveLeg {
  readonly configId: string; readonly strategy: "atlas" | "paged"; readonly lightCount: number;
  readonly lights: readonly EvaluationSpotLight[]; readonly plan: LegPlan; readonly cpuPlanUs: number;
  readonly device: GPUDevice;
  readonly shadowTextures: GPUTexture[]; readonly shadowViews: GPUTextureView[];
  readonly shadowUniforms: GPUBuffer[]; readonly boxBuffers: GPUBuffer[]; readonly boxCounts: number[];
  readonly frameUniforms: GPUBuffer[]; readonly dummyTexture: GPUTexture; readonly dummyView: GPUTextureView;
  readonly shadowPipeline: GPURenderPipeline; readonly receiverPipeline: GPURenderPipeline;
  readonly receiverSampler: GPUSampler; readonly target: GPUTexture; readonly readback: GPUBuffer;
  readonly screenRects: readonly (readonly [number, number, number, number])[];
  readonly patchPixels: readonly (readonly [number, number, number, number])[];
  gpuFrameMs: number[];
}

let active: ActiveLeg | undefined;
let legPng: Uint8Array<ArrayBuffer> | undefined;

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture };
}

export async function beginLeg(configId: string, lightCount: number): Promise<void> {
  if (active) throw new Error("Previous leg was not ended.");
  const config = LEG_CONFIGS.find(entry => entry.id === configId);
  if (!config) throw new Error(`Unknown leg config: ${configId}.`);
  const { lights } = buildEvaluationLights(lightCount);
  const planLeg = (): LegPlan => config.strategy === "atlas"
    ? planAtlasLeg(lights, EVALUATION_BUDGET_BYTES, config.options as AtlasLegOptions)
    : planPagedLeg(lights, EVALUATION_BUDGET_BYTES, config.options as PagedLegOptions);
  const plan = planLeg();
  let cpuPlanUs = 0;
  for (let index = 0; index < 200; index += 1) {
    const start = performance.now();
    planLeg();
    cpuPlanUs += performance.now() - start;
  }
  cpuPlanUs = cpuPlanUs / 200 * 1000;
  const adapter = await navigator.gpu!.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const device = await adapter.requestDevice();
  const texelCounts = new Map(plan.shadowed.map(entry => [entry.key, entry.texels]));
  const byKey = new Map(lights.map(light => [light.key, light]));

  const shadowTextures: GPUTexture[] = [], shadowViews: GPUTextureView[] = [], shadowUniforms: GPUBuffer[] = [];
  const boxBuffers: GPUBuffer[] = [], boxCounts: number[] = [], frameUniforms: GPUBuffer[] = [];
  const basis = cameraBasis();
  const viewProjection = multiply(perspective(CAMERA.verticalFovRadians, WIDTH / HEIGHT, 0.5, 300),
    lookAt(CAMERA.eye, CAMERA.target));
  const screenRects: (readonly [number, number, number, number])[] = [];
  const patchPixels: (readonly [number, number, number, number])[] = [];
  const frameUniformData = new Float32Array(FRAME_UNIFORM_FLOATS);
  frameUniformData.set(CAMERA.eye, 0);
  frameUniformData.set(basis.forward, 4);
  frameUniformData.set(basis.right, 8);
  frameUniformData.set(basis.up, 12);
  frameUniformData[16] = Math.tan(CAMERA.verticalFovRadians / 2);
  frameUniformData[17] = WIDTH / HEIGHT;
  frameUniformData[30] = WIDTH;
  frameUniformData[31] = HEIGHT;
  for (const light of lights) {
    const rect = patchRect(light, viewProjection);
    screenRects.push(rect);
    patchPixels.push([rect[0], rect[1], rect[2], rect[3]]);
    frameUniformData[18] = light.patchHalfExtent;
    frameUniformData[19] = texelCounts.has(light.key) ? 1 : 0;
    frameUniformData.set(light.position, 20);
    frameUniformData.set(light.patchCenter, 24);
    const texels = texelCounts.get(light.key);
    frameUniformData[26] = texels ?? 1;
    frameUniformData[27] = 1 / (texels ?? 1);
    // 1 texel 当量深度偏移:z_ndc = A + B/z(B = fn/(f-n)),dz_ndc/dz = B/z²,z 取灯高,
    // texel 世界尺寸 = 光锥宽/texels。分辨率越高偏移越小,避免粗图偏移渗漏。
    const texelWorld = 2 * Math.tan(light.outerHalfAngleRadians) * EVALUATION_LIGHT_HEIGHT / (texels ?? 512);
    const depthSlope = (0.5 * light.range / (light.range - 0.5)) / (EVALUATION_LIGHT_HEIGHT * EVALUATION_LIGHT_HEIGHT);
    frameUniformData[28] = depthSlope * texelWorld;
    frameUniformData[29] = 1;
    const lightViewProjection = new Float32Array(16);
    lightViewProjection.set(multiply(
      perspective(2 * light.outerHalfAngleRadians, 1, 0.5, light.range),
      lookAt(light.position, [light.position[0]! + light.direction[0]!, light.position[1]! + light.direction[1]!,
        light.position[2]! + light.direction[2]!], [0, 0, 1])));
    frameUniformData.set(lightViewProjection, 32);
    const uniform = device.createBuffer({ size: FRAME_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, frameUniformData);
    frameUniforms.push(uniform);
    if (texels !== undefined) {
      const boxData = emitBoxes(byKey.get(light.key)!.occluders);
      const boxBuffer = device.createBuffer({ size: boxData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(boxBuffer, 0, boxData);
      boxBuffers.push(boxBuffer);
      boxCounts.push(boxData.length / 3);
      const shadowUniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(shadowUniform, 0, lightViewProjection);
      shadowUniforms.push(shadowUniform);
      shadowTextures.push(device.createTexture({ label: `shadow-${light.key}`, size: [texels, texels],
        format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
      shadowViews.push(shadowTextures[shadowTextures.length - 1]!.createView());
    }
  }
  const shadowModule = device.createShaderModule({ code: SHADOW_WGSL });
  const receiverModule = device.createShaderModule({ code: RECEIVER_WGSL });
  const shadowPipeline = device.createRenderPipeline({ layout: "auto",
    vertex: { module: shadowModule, entryPoint: "vs", buffers: [{ arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" } });
  const receiverPipeline = device.createRenderPipeline({ layout: "auto",
    vertex: { module: receiverModule, entryPoint: "vs" },
    fragment: { module: receiverModule, entryPoint: "fs", targets: [{ format: "rgba16float" }] } });
  const receiverSampler = device.createSampler({ compare: "less-equal", minFilter: "linear", magFilter: "linear" });
  const dummyTexture = device.createTexture({ size: [1, 1], format: "depth32float",
    usage: GPUTextureUsage.TEXTURE_BINDING });
  const target = device.createTexture({ label: "receiver", size: [WIDTH, HEIGHT], format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ size: WIDTH * 8 * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  active = { configId, strategy: config.strategy, lightCount, lights, plan, cpuPlanUs, device,
    shadowTextures, shadowViews, shadowUniforms, boxBuffers, boxCounts, frameUniforms, dummyTexture,
    dummyView: dummyTexture.createView(), shadowPipeline, receiverPipeline, receiverSampler, target,
    readback, screenRects, patchPixels, gpuFrameMs: [] };
}

function encodeFrame(leg: ActiveLeg): GPUCommandBuffer {  const device = leg.device;
  const encoder = device.createCommandEncoder();
  const shadowedIndex = new Map(leg.plan.shadowed.map((entry, index) => [entry.key, index]));
  leg.lights.forEach((light, lightIndex) => {
    const shadowIndex = shadowedIndex.get(light.key);
    if (shadowIndex !== undefined) {
      const pass = encoder.beginRenderPass({ colorAttachments: [],
        depthStencilAttachment: { view: leg.shadowViews[shadowIndex]!, depthClearValue: 1,
          depthLoadOp: "clear", depthStoreOp: "store" } });
      pass.setPipeline(leg.shadowPipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: leg.shadowPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: leg.shadowUniforms[shadowIndex]! } }] }));
      pass.setVertexBuffer(0, leg.boxBuffers[shadowIndex]!);
      pass.draw(leg.boxCounts[shadowIndex]!);
      pass.end();
    }
    const rect = leg.screenRects[lightIndex]!;
    const bindGroup = device.createBindGroup({ layout: leg.receiverPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: leg.frameUniforms[lightIndex]! } },
        { binding: 1, resource: shadowIndex === undefined ? leg.dummyView : leg.shadowViews[shadowIndex]! },
        { binding: 2, resource: leg.receiverSampler }] });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: leg.target.createView(),
      loadOp: lightIndex === 0 ? "clear" : "load", storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(leg.receiverPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setViewport(rect[0], rect[1], rect[2], rect[3], 0, 1);
    pass.setScissorRect(rect[0], rect[1], rect[2], rect[3]);
    pass.draw(3);
    pass.end();
  });
  return encoder.finish();
}

export async function stepLeg(count: number): Promise<readonly number[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const frames: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const command = encodeFrame(active);
    const start = performance.now();
    active.device.queue.submit([command]);
    await active.device.queue.onSubmittedWorkDone();
    active.gpuFrameMs.push(performance.now() - start);
    frames.push(index);
  }
  return frames;
}

export async function endLeg(): Promise<LegEvaluation> {
  if (!active) throw new Error("beginLeg was not called.");
  const leg = active;
  const encoder = leg.device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: leg.target }, { buffer: leg.readback, bytesPerRow: WIDTH * 8,
    rowsPerImage: HEIGHT }, [WIDTH, HEIGHT]);
  leg.device.queue.submit([encoder.finish()]);
  await leg.readback.mapAsync(GPUMapMode.READ);
  const raw16 = new Uint16Array(leg.readback.getMappedRange().slice(0));
  leg.readback.unmap();
  const luminance = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const rowStart = y * WIDTH * 4;
    for (let x = 0; x < WIDTH; x += 1) luminance[y * WIDTH + x] = decodeHalfFloat(raw16[rowStart + x * 4]!);
  }
  const basis = cameraBasis();
  const perLight: PerLightQuality[] = [];
  // 聚合判据按"行宽 = 最大补丁宽"堆叠各行;行内非补丁像素与行尾 padding 均 mask=0。
  const aggregateRows: { measured: number[]; reference: number[]; mask: number[] }[] = [];
  let referenceShadowedSamples = 0;
  const shadowedTexels = new Map(leg.plan.shadowed.map(entry => [entry.key, entry.texels]));
  leg.lights.forEach((light, lightIndex) => {
    const [rx, ry, rw, rh] = leg.patchPixels[lightIndex]!;
    const size = rw * rh;
    const measured = new Float32Array(size), reference = new Float32Array(size), mask = new Uint8Array(size);
    let insidePixels = 0;
    for (let y = 0; y < rh; y += 1) {
      for (let x = 0; x < rw; x += 1) {
        const ndcX = 2 * (rx + x + 0.5) / WIDTH - 1, ndcY = 1 - 2 * (ry + y + 0.5) / HEIGHT;
        const ray = cameraRay(basis, ndcX, ndcY);
        if (Math.abs(ray[1]) < 1e-6) continue;
        const t = -CAMERA.eye[1] / ray[1];
        if (t <= 0) continue;
        const point: [number, number, number] = [CAMERA.eye[0] + ray[0] * t, 0, CAMERA.eye[2] + ray[2] * t];
        const inside = Math.abs(point[0] - light.patchCenter[0]) <= light.patchHalfExtent
          && Math.abs(point[2] - light.patchCenter[1]) <= light.patchHalfExtent;
        const index = y * rw + x;
        measured[index] = luminance[(ry + y) * WIDTH + rx + x]! / spotIrradiance(point, light);
        reference[index] = inside && analyticSpotVisibility(point, light) ? 0 : 1;
        mask[index] = inside ? 1 : 0;
        if (inside) insidePixels += 1;
      }
    }
    if (insidePixels === 0) {
      throw new Error(`Patch ${light.key} has no floor samples. rect=${JSON.stringify(leg.patchPixels[lightIndex])}`);
    }
    const stats = summarizeShadowQuality(measured, reference, mask, rw);
    referenceShadowedSamples += stats.shadowedSamples;
    for (let y = 0; y < rh; y += 1) {
      aggregateRows.push({ measured: [...measured.subarray(y * rw, (y + 1) * rw)],
        reference: [...reference.subarray(y * rw, (y + 1) * rw)],
        mask: [...mask.subarray(y * rw, (y + 1) * rw)] });
    }
    perLight.push({ key: light.key, texels: shadowedTexels.get(light.key) ?? 0,
      shadowed: shadowedTexels.has(light.key), stats });
  });
  const aggregate = aggregateShadowStats(aggregateRows);
  const png = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    const channel = Math.round(255 * Math.pow(Math.max(0, Math.min(1, luminance[index]! / 2.6)), 1 / 2.2));
    png[index * 3] = channel; png[index * 3 + 1] = channel; png[index * 3 + 2] = channel;
  }
  legPng = png;
  const mean = leg.gpuFrameMs.length > 0
    ? leg.gpuFrameMs.reduce((total, value) => total + value, 0) / leg.gpuFrameMs.length : null;
  const evaluation: LegEvaluation = { configId: leg.configId, strategy: leg.strategy,
    lightCount: leg.lightCount, coverage: leg.plan.shadowed.length / leg.lights.length,
    shadowedKeys: leg.plan.shadowed.map(entry => entry.key), unshadowedKeys: leg.plan.unshadowed,
    perLight, aggregate, referenceShadowedSamples, depthBytes: leg.plan.depthBytes,
    budgetBytes: EVALUATION_BUDGET_BYTES,
    gpuFrameMs: mean === null ? null : Number(mean.toFixed(4)), cpuPlanUs: Number(leg.cpuPlanUs.toFixed(3)) };
  for (const texture of leg.shadowTextures) texture.destroy();
  leg.dummyTexture.destroy();
  leg.target.destroy();
  for (const buffer of [...leg.shadowUniforms, ...leg.boxBuffers, ...leg.frameUniforms, leg.readback]) {
    buffer.destroy();
  }
  leg.device.destroy();
  active = undefined;
  return evaluation;
}

/** endLeg 之后取 8-bit PNG 字节（node 侧编码 PNG）。 */
export function legPngBytes(): Uint8Array<ArrayBuffer> {
  if (!legPng) throw new Error("Leg produced no PNG bytes.");
  return legPng;
}
