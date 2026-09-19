/// <reference types="@webgpu/types" />
import { buildHiZFirstStageKernel, buildHiZVariableReduceKernel, DCIR_GLSL_VERTEX, emitKernelGlsl, emitKernelWgsl,
  generateHiZInput, hiZChainLevelCount, hiZChainLevelSize, referenceHiZChain, referenceHiZFirstStage,
  referenceHiZVariableReduce, usesAnchoredReduce } from "../src/shaderCompute/index.js";
import { compileShader } from "./r2ShaderIrProbeWebGl.js";

// Node 侧 runner 与浏览器共用同一 bundle：输入生成、参考实现与发射器只此一份（防口径分叉）。
export {
  buildHiZFirstStageKernel, buildHiZVariableReduceKernel, emitKernelGlsl, emitKernelWgsl, generateHiZInput,
  hiZChainLevelCount, hiZChainLevelSize, referenceHiZChain, referenceHiZFirstStage, referenceHiZVariableReduce,
  usesAnchoredReduce,
} from "../src/shaderCompute/index.js";

/**
 * R4 生产 HiZ 接线真机对拍探针（scripts/r4HiZWiringGpuTest.mjs 驱动，headless Chrome）。
 * 同一浏览器进程内：
 * - WebGPU（Dawn）：golden 手写 reduce WGSL（迁移前原文，黄金夹具）与 DCIR 生成的生产内核
 *   在同一输入、同一金字塔尺寸上跑完整 reduce 链，逐级回读对比 + timestamp 计时。
 * - WebGL2（ANGLE）：同一 DCIR 源的 GLSL 降级（全屏 pass）执行生产第一档，与 WebGPU 第一档
 *   与 CPU 参考对拍。生产无 WebGL2 HiZ 消费路径（R2 审计），此处按 R2 合同验证降级语义。
 */

/** 黄金夹具：迁移前的手写 HI_Z_REDUCE_WGSL 原文（webgpu/hiZPyramid.ts r2 提交版）。 */
export const GOLDEN_HI_Z_REDUCE_WGSL = /* wgsl */ `
override REDUCE_MAX: bool = true;
@group(0) @binding(0) var sourceMip: texture_2d<f32>;
@group(0) @binding(1) var targetMip: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn reduceDepth(@builtin(global_invocation_id) id: vec3<u32>) {
  let targetSize = textureDimensions(targetMip);
  if (id.x >= targetSize.x || id.y >= targetSize.y) { return; }
  let sourceSize = textureDimensions(sourceMip);
  let begin = id.xy * sourceSize / targetSize;
  let end = ((id.xy + vec2<u32>(1u)) * sourceSize + targetSize - vec2<u32>(1u)) / targetSize;
  var value = textureLoad(sourceMip, vec2<i32>(begin), 0).x;
  for (var y = begin.y; y < end.y; y++) {
    for (var x = begin.x; x < end.x; x++) {
      let sampleDepth = textureLoad(sourceMip, vec2<i32>(i32(x), i32(y)), 0).x;
      value = select(min(value, sampleDepth), max(value, sampleDepth), REDUCE_MAX);
    }
  }
  textureStore(targetMip, id.xy, vec4<f32>(value, 0.0, 0.0, 0.0));
}
`;

export interface R4CaseRequest {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly reduceMax: boolean;
  /** level 0 输入（紧凑 f32 行序）。 */
  readonly inputBase64: string;
  readonly perfRepeats: number;
  readonly perfSamples: number;
}

export interface R4BackendCaseResult {
  /** 每级 base64（level 0..N-1），两遍重复用于后端内稳定性。perf-only case 为空数组。 */
  readonly oldRepeats: readonly (readonly string[])[];
  readonly newRepeats: readonly (readonly string[])[];
  /** timestamp 计时样本（ticks/链）。 */
  readonly perfOldTicks: readonly number[];
  readonly perfNewTicks: readonly number[];
}

export interface R4GlslCaseResult {
  readonly outputBase64: string;
  readonly glError: number;
  readonly otherChannelMaxAbs: number;
  readonly kernel: string;
}

export interface R4ProbeResult {
  readonly webgpu?: {
    readonly adapter: Readonly<Record<string, string | number>>;
    readonly features: readonly string[];
    readonly timestampQuery: boolean;
    readonly validationMessages: readonly string[];
    readonly cases: Readonly<Record<string, R4BackendCaseResult>>;
  };
  readonly webgl?: {
    readonly version: string;
    readonly unmaskedRenderer: string;
    readonly unmaskedVendor: string;
    readonly floatRenderable: boolean;
    readonly cases: Readonly<Record<string, R4GlslCaseResult>>;
  };
  readonly errors: readonly string[];
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const rowPadding = (rowBytes: number): number => Math.ceil(rowBytes / 256) * 256;

const workgroupDispatch = (size: number): number => Math.ceil(size / 8);

/** writeTimestamp 属 timestamp-query feature;本仓 @webgpu/types 版本尚未收录该签名,局部收窄。 */
interface TimestampCommandEncoder extends GPUCommandEncoder {
  writeTimestamp(querySet: GPUQuerySet, queryIndex: number): void;
}
const encoderWithTimestamp = (encoder: GPUCommandEncoder): TimestampCommandEncoder => encoder as TimestampCommandEncoder;

interface PyramidRig {
  readonly texture: GPUTexture;
  readonly views: readonly GPUTextureView[];
  readonly bindings: readonly GPUBindGroup[];
  readonly uniforms: readonly GPUBuffer[];
}

/** golden 布局无 uniform binding;DCIR 布局含 binding 2。bind group 条目数必须与各自 layout 一致。 */
function seedPyramid(device: GPUDevice, layout: GPUBindGroupLayout, width: number, height: number,
  mipLevelCount: number, label: string, withUniform: boolean): PyramidRig {
  const texture = device.createTexture({ label: `r4-${label}`, size: { width, height }, format: "r32float",
    mipLevelCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST
      | GPUTextureUsage.COPY_SRC });
  const views = Array.from({ length: mipLevelCount }, (_, level) => texture.createView({
    label: `r4-${label}-mip${level}`, format: "r32float", dimension: "2d",
    baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 }));
  const uniforms: GPUBuffer[] = [];
  const bindings = Array.from({ length: mipLevelCount - 1 }, (_, index) => {
    const source = hiZChainLevelSize(width, index), target = hiZChainLevelSize(width, index + 1);
    const sourceHeight = hiZChainLevelSize(height, index), targetHeight = hiZChainLevelSize(height, index + 1);
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: views[index]! }, { binding: 1, resource: views[index + 1]! },
    ];
    if (withUniform) {
      const uniform = device.createBuffer({ label: `r4-${label}-u${index + 1}`, size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(uniform, 0, new Uint32Array([source, sourceHeight, target, targetHeight]));
      uniforms.push(uniform);
      entries.push({ binding: 2, resource: uniform });
    }
    return device.createBindGroup({ layout, entries });
  });
  return { texture, views, bindings, uniforms };
}

function encodeChain(encoder: GPUCommandEncoder, rig: PyramidRig, pipelines: {
    golden: GPUComputePipeline; anchored: GPUComputePipeline; variable: GPUComputePipeline;
  }, kind: "golden" | "dcir", width: number, height: number, mipLevelCount: number): void {
  for (let level = 1; level < mipLevelCount; level++) {
    const targetWidth = hiZChainLevelSize(width, level), targetHeight = hiZChainLevelSize(height, level);
    // 与生产 encodePasses 同构：按该级源尺寸奇偶选 anchored/variable。
    const sourceWidth = hiZChainLevelSize(width, level - 1), sourceHeight = hiZChainLevelSize(height, level - 1);
    const pipeline = kind === "golden" ? pipelines.golden
      : usesAnchoredReduce(sourceWidth, sourceHeight) ? pipelines.anchored : pipelines.variable;
    const pass = encoder.beginComputePass({ label: `r4-${kind}-${level}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, rig.bindings[level - 1]!);
    pass.dispatchWorkgroups(workgroupDispatch(targetWidth), workgroupDispatch(targetHeight));
    pass.end();
  }
}

async function readPyramid(device: GPUDevice, rig: PyramidRig, width: number, height: number,
  mipLevelCount: number): Promise<Float32Array[]> {
  const levels: Float32Array[] = [];
  for (let level = 0; level < mipLevelCount; level++) {
    const levelWidth = hiZChainLevelSize(width, level), levelHeight = hiZChainLevelSize(height, level);
    const bytesPerRow = rowPadding(levelWidth * 4);
    const readback = device.createBuffer({ label: `r4-read-${level}`, size: bytesPerRow * levelHeight,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder({ label: `r4-read-${level}` });
    encoder.copyTextureToBuffer({ texture: rig.texture, mipLevel: level },
      { buffer: readback, bytesPerRow, rowsPerImage: levelHeight }, { width: levelWidth, height: levelHeight });
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const packed = new Uint8Array(readback.getMappedRange() as ArrayBuffer).slice();
    readback.unmap(); readback.destroy();
    const output = new Float32Array(levelWidth * levelHeight);
    for (let row = 0; row < levelHeight; row++) {
      output.set(new Float32Array(packed.buffer, row * bytesPerRow, levelWidth), row * levelWidth);
    }
    levels.push(output);
  }
  return levels;
}

async function runWebGpuCase(device: GPUDevice, request: R4CaseRequest, pipelines: {
    golden: GPUComputePipeline; anchored: GPUComputePipeline; variable: GPUComputePipeline;
  }, goldenLayout: GPUBindGroupLayout, dcirLayout: GPUBindGroupLayout,
  timestampQuery: boolean): Promise<R4BackendCaseResult> {
  const { width, height, reduceMax, perfRepeats, perfSamples } = request;
  const mipLevelCount = hiZChainLevelCount(width, height);
  const captureOutputs = perfRepeats === 0;
  const input = new Float32Array((base64ToBytes(request.inputBase64).buffer as ArrayBuffer).slice(0));
  const upload = new Uint8Array(rowPadding(width * 4) * height);
  const compact = new Uint8Array(input.buffer);
  for (let row = 0; row < height; row++) {
    upload.set(compact.subarray(row * width * 4, (row + 1) * width * 4), row * rowPadding(width * 4));
  }
  const golden = seedPyramid(device, goldenLayout, width, height, mipLevelCount, "golden", false);
  const dcir = seedPyramid(device, dcirLayout, width, height, mipLevelCount, "dcir", true);
  for (const rig of [golden, dcir]) {
    device.queue.writeTexture({ texture: rig.texture, mipLevel: 0 }, upload,
      { bytesPerRow: rowPadding(width * 4), rowsPerImage: height }, { width, height });
  }
  const oldRepeats: string[][] = [];
  const newRepeats: string[][] = [];
  try {
    for (let repeat = 0; repeat < (captureOutputs ? 2 : 0); repeat++) {
      const encoder = device.createCommandEncoder({ label: `r4-run-${repeat}` });
      encodeChain(encoder, golden, pipelines, "golden", width, height, mipLevelCount);
      encodeChain(encoder, dcir, pipelines, "dcir", width, height, mipLevelCount);
      device.queue.submit([encoder.finish()]);
      const [oldLevels, newLevels] = await Promise.all([
        readPyramid(device, golden, width, height, mipLevelCount),
        readPyramid(device, dcir, width, height, mipLevelCount),
      ]);
      oldRepeats.push(oldLevels.map((level) => bytesToBase64(new Uint8Array(level.buffer))));
      newRepeats.push(newLevels.map((level) => bytesToBase64(new Uint8Array(level.buffer))));
    }

    const perfOldTicks: number[] = [];
    const perfNewTicks: number[] = [];
    if (timestampQuery && perfRepeats > 0) {
      const querySet = device.createQuerySet({ label: "r4-timestamps", type: "timestamp", count: 4 });
      const resolveBuffer = device.createBuffer({ label: "r4-resolve", size: 32,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const readback = device.createBuffer({ label: "r4-perf-read", size: 32,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        for (let sample = 0; sample < perfSamples; sample++) {
          const encoder = device.createCommandEncoder({ label: `r4-perf-${sample}` });
          encoderWithTimestamp(encoder).writeTimestamp(querySet, 0);
          for (let repeat = 0; repeat < perfRepeats; repeat++) {
            encodeChain(encoder, golden, pipelines, "golden", width, height, mipLevelCount);
          }
          encoderWithTimestamp(encoder).writeTimestamp(querySet, 1);
          for (let repeat = 0; repeat < perfRepeats; repeat++) {
            encodeChain(encoder, dcir, pipelines, "dcir", width, height, mipLevelCount);
          }
          encoderWithTimestamp(encoder).writeTimestamp(querySet, 2);
          encoder.resolveQuerySet(querySet, 0, 3, resolveBuffer, 0);
          encoder.copyBufferToBuffer(resolveBuffer, 0, readback, 0, 32);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const ticks = new BigUint64Array(readback.getMappedRange() as ArrayBuffer).slice();
          readback.unmap();
          perfOldTicks.push(Number(ticks[1]! - ticks[0]!) / perfRepeats);
          perfNewTicks.push(Number(ticks[2]! - ticks[1]!) / perfRepeats);
        }
      } finally {
        resolveBuffer.destroy(); readback.destroy();
      }
    }
    return { oldRepeats, newRepeats, perfOldTicks, perfNewTicks };
  } finally {
    golden.texture.destroy();
    dcir.texture.destroy();
    for (const uniform of golden.uniforms) uniform.destroy();
    for (const uniform of dcir.uniforms) uniform.destroy();
  }
}

export async function runR4HiZWiringProbe(requests: readonly R4CaseRequest[]): Promise<R4ProbeResult> {
  const errors: string[] = [];
  const emitted = {
    anchored: { min: emitKernelWgsl(buildHiZFirstStageKernel(false)), max: emitKernelWgsl(buildHiZFirstStageKernel(true)) },
    variable: { min: emitKernelWgsl(buildHiZVariableReduceKernel(false)), max: emitKernelWgsl(buildHiZVariableReduceKernel(true)) },
  };
  const glsl = {
    anchored: { min: emitKernelGlsl(buildHiZFirstStageKernel(false)), max: emitKernelGlsl(buildHiZFirstStageKernel(true)) },
    variable: { min: emitKernelGlsl(buildHiZVariableReduceKernel(false)), max: emitKernelGlsl(buildHiZVariableReduceKernel(true)) },
  };
  let webgpu: R4ProbeResult["webgpu"];
  let webgl: R4ProbeResult["webgl"];

  try {
    if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("requestAdapter returned null.");
    const timestampQuery = adapter.features.has("timestamp-query");
    const device = await adapter.requestDevice({ label: "r4-hiz-wiring-probe",
      requiredFeatures: timestampQuery ? ["timestamp-query"] : [] });
    device.addEventListener?.("uncapturederror", (event) => { errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`); });
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    const validationMessages: string[] = [];
    const goldenModule = device.createShaderModule({ label: "r4-golden-reduce", code: GOLDEN_HI_Z_REDUCE_WGSL });
    // 显式布局与生产同构(hiZPyramid.ts 用显式 layout 让全部管线共享同一 layout 对象):
    // auto layout 是每条管线独立对象,跨管线复用 bind group 会被 identity 校验拒绝。
    const goldenLayout = device.createBindGroupLayout({ label: "r4-golden-layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float", viewDimension: "2d" } },
    ] });
    const dcirLayout = device.createBindGroupLayout({ label: "r4-dcir-layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float", viewDimension: "2d" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    const goldenPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [goldenLayout] });
    const dcirPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [dcirLayout] });
    const goldenPipeline = device.createComputePipeline({ label: "r4-golden", layout: goldenPipelineLayout,
      compute: { module: goldenModule, entryPoint: "reduceDepth", constants: { REDUCE_MAX: 0 } } });
    // golden 的 REDUCE_MAX 由 constants 控制模式；以 pipeline 常量注入两种模式需要两条管线。
    const goldenPipelineMax = device.createComputePipeline({ label: "r4-golden-max", layout: goldenPipelineLayout,
      compute: { module: goldenModule, entryPoint: "reduceDepth", constants: { REDUCE_MAX: 1 } } });
    const dcirPipelines: Record<string, GPUComputePipeline> = {};
    for (const family of ["anchored", "variable"] as const) {
      for (const mode of ["min", "max"] as const) {
        const module = device.createShaderModule({ label: `r4-${family}-${mode}`, code: emitted[family][mode].code });
        for (const message of (await module.getCompilationInfo()).messages) {
          if (message.type !== "info") validationMessages.push(`${family}-${mode}:${message.type}:${message.lineNum}:${message.message}`);
        }
        dcirPipelines[`${family}:${mode}`] = device.createComputePipeline({ label: `r4-${family}-${mode}`,
          layout: dcirPipelineLayout,
          compute: { module, entryPoint: family === "anchored" ? "hi_z_first_stage" : "hi_z_variable_reduce" } });
      }
    }
    for (const message of (await goldenModule.getCompilationInfo()).messages) {
      if (message.type !== "info") validationMessages.push(`golden:${message.type}:${message.lineNum}:${message.message}`);
    }
    const cases: Record<string, R4BackendCaseResult> = {};
    device.pushErrorScope("validation");
    for (const request of requests) {
      const pipelines = {
        golden: request.reduceMax ? goldenPipelineMax : goldenPipeline,
        anchored: dcirPipelines[`anchored:${request.reduceMax ? "max" : "min"}`]!,
        variable: dcirPipelines[`variable:${request.reduceMax ? "max" : "min"}`]!,
      };
      cases[request.name] = await runWebGpuCase(device, request, pipelines, goldenLayout, dcirLayout, timestampQuery);
    }
    const pipelineValidation = await device.popErrorScope();
    if (pipelineValidation) validationMessages.push(`pipeline:${pipelineValidation.message}`);
    webgpu = {
      adapter: {
        vendor: info?.vendor ?? "", architecture: info?.architecture ?? "", device: info?.device ?? "",
        description: info?.description ?? "",
      },
      features: [...adapter.features].sort(),
      timestampQuery,
      validationMessages,
      cases,
    };
    device.destroy();
  } catch (error) {
    errors.push(`webgpu: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: false,
      powerPreference: "high-performance" });
    if (!gl) throw new Error("webgl2 context unavailable.");
    const floatExt = gl.getExtension("EXT_color_buffer_float");
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const linkProgram = (fragment: string): WebGLProgram => {
      const linked = gl.createProgram()!;
      gl.attachShader(linked, compileShader(gl, gl.VERTEX_SHADER, DCIR_GLSL_VERTEX));
      gl.attachShader(linked, compileShader(gl, gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(linked);
      if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
        throw new Error(`GLSL link failed: ${gl.getProgramInfoLog(linked) ?? "no log"}`);
      }
      return linked;
    };
    const programs = {
      "anchored:min": linkProgram(glsl.anchored.min.fragment), "anchored:max": linkProgram(glsl.anchored.max.fragment),
      "variable:min": linkProgram(glsl.variable.min.fragment), "variable:max": linkProgram(glsl.variable.max.fragment),
    };
    const cases: Record<string, R4GlslCaseResult> = {};
    if (floatExt) for (const request of requests) {
      cases[request.name] = runWebGlFirstStage(gl, programs, request);
    }
    webgl = {
      version: gl.getParameter(gl.VERSION) as string,
      unmaskedRenderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "",
      unmaskedVendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : "",
      floatRenderable: Boolean(floatExt),
      cases,
    };
  } catch (error) {
    errors.push(`webgl: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...(webgpu ? { webgpu } : {}), ...(webgl ? { webgl } : {}), errors };
}

/** WebGL2 第一档降级（R2 合同语义：全屏 fragment pass + R32F FBO；生产无 WebGL2 HiZ 消费路径）。 */
function runWebGlFirstStage(gl: WebGL2RenderingContext, programs: Readonly<Record<string, WebGLProgram>>,
  request: R4CaseRequest): R4GlslCaseResult {
  const sw = request.width, sh = request.height;
  const tw = hiZChainLevelSize(sw, 1), th = hiZChainLevelSize(sh, 1);
  const key = `${usesAnchoredReduce(sw, sh) ? "anchored" : "variable"}:${request.reduceMax ? "max" : "min"}`;
  const program = programs[key]!;
  const input = new Float32Array((base64ToBytes(request.inputBase64).buffer as ArrayBuffer).slice(0));
  const source = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, sw, sh, 0, gl.RED, gl.FLOAT, input);
  const target = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, tw, th, 0, gl.RED, gl.FLOAT, null);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("R32F framebuffer incomplete.");
  // target 曾占用 TEXTURE0：绘制前必须绑回 source，否则 FBO 附件与采样器成反馈环 → GL_INVALID_OPERATION。
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, source);
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.DITHER); gl.disable(gl.SCISSOR_TEST);
  gl.useProgram(program);
  gl.uniform2ui(gl.getUniformLocation(program, "deep_u_sourceSize"), sw, sh);
  gl.uniform2ui(gl.getUniformLocation(program, "deep_u_targetSize"), tw, th);
  gl.uniform1i(gl.getUniformLocation(program, "deepSource"), 0);
  gl.viewport(0, 0, tw, th);
  let glError = 0;
  let otherChannelMaxAbs = 0;
  let output = new Float32Array(0);
  try {
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    glError = gl.getError();
    if (glError !== gl.NO_ERROR) throw new Error(`gl.getError() = 0x${glError.toString(16)} after drawArrays.`);
    const packed = new Float32Array(tw * th * 4);
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.FLOAT, packed);
    glError = gl.getError();
    if (glError !== gl.NO_ERROR) throw new Error(`gl.getError() = 0x${glError.toString(16)} after readPixels.`);
    output = new Float32Array(tw * th);
    for (let texel = 0; texel < tw * th; texel++) {
      output[texel] = packed[texel * 4]!;
      otherChannelMaxAbs = Math.max(otherChannelMaxAbs, Math.abs(packed[texel * 4 + 1]!));
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer); gl.deleteTexture(source); gl.deleteTexture(target);
  }
  return { outputBase64: bytesToBase64(new Uint8Array(output.buffer)), glError, otherChannelMaxAbs, kernel: key };
}
