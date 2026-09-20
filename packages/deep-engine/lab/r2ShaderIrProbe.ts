/// <reference types="@webgpu/types" />
import {
  buildHiZFirstStageKernel, buildHiZFirstStageSubgroupKernel, DCIR_GLSL_VERTEX, emitKernelGlsl, emitKernelWgsl,
  hiZFirstStageSubgroupDispatchSize, hiZFirstStageTargetSize,
} from "../src/shaderCompute/index.js";
import { compileShader, DIAGNOSTIC_FRAGMENT, runWebGlCase } from "./r2ShaderIrProbeWebGl.js";

// Node 侧 runner 与浏览器共用同一 bundle：输入生成、参考实现与发射器只此一份（防口径分叉）。
export {
  buildHiZFirstStageKernel, buildHiZFirstStageSubgroupKernel, emitKernelGlsl, emitKernelWgsl, generateHiZInput,
  hiZFirstStageSubgroupDispatchSize, hiZFirstStageTargetSize, referenceHiZFirstStage, referenceHiZFirstStageSubgroup,
} from "../src/shaderCompute/index.js";

/**
 * R2 真机双后端探针（headless Chrome + playwright 由 scripts/r2ShaderIrGpuTest.mjs 驱动）。
 * 同一浏览器进程内：WebGPU（Dawn）执行 IR 生成的 WGSL compute，WebGL2（ANGLE）执行同一 IR
 * 生成的 GLSL fragment 降级（执行器见 r2ShaderIrProbeWebGl.ts）；每案例执行两次以记录后端内
 * 重复稳定性。数值哈希在 Node 侧计算。
 */

export interface R2CaseRequest {
  readonly name: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly reduceMax: boolean;
  readonly inputBase64: string;
  /** subgroup 变体案例：仅 WebGPU（GLSL 发射 fail-closed），且需 adapter 暴露 subgroups feature。 */
  readonly webgpuOnly?: boolean;
  readonly subgroupSize?: number;
}

export interface R2BackendCaseResult {
  readonly repeatsBase64: readonly [string, string];
  readonly validationMessages: readonly string[];
  /** 该案例在后端缺席的原因（webgpu-only 案例在 WebGL2 / 无 subgroups feature 时）。 */
  readonly skippedReason?: string;
  /** 仅 WebGL2：gl.getError() 与未写通道的最大幅度（通道混写哨兵，应为 0）。 */
  readonly glError?: number;
  readonly otherChannelMaxAbs?: number;
  /** 仅 WebGL2：诊断程序直出的 uniform（r=reduceMax, g=targetSize.y, b=sourceSize.x）。 */
  readonly uniformShaderEcho?: readonly [number, number, number];
}

export interface R2ProbeResult {
  readonly webgpu?: {
    readonly adapter: Readonly<Record<string, string | number>>;
    readonly features: readonly string[];
    /** adapter 是否暴露 subgroups feature（subgroup 案例的可探测拒绝依据）。 */
    readonly subgroupsFeature: boolean;
    readonly cases: Readonly<Record<string, R2BackendCaseResult>>;
  };
  readonly webgl?: {
    readonly version: string;
    readonly unmaskedRenderer: string;
    readonly unmaskedVendor: string;
    readonly floatRenderable: boolean;
    readonly cases: Readonly<Record<string, R2BackendCaseResult>>;
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

async function runWebGpuCase(device: GPUDevice, pipelines: Readonly<Record<string, GPUComputePipeline>>,
  request: R2CaseRequest, options: Readonly<{ subgroup?: boolean }> = {}): Promise<R2BackendCaseResult> {
  const mode = request.reduceMax ? "max" : "min";
  const pipeline = pipelines[options.subgroup ? `sub${mode}` : mode]!;
  const sw = request.sourceWidth, sh = request.sourceHeight;
  const [tw, th] = hiZFirstStageTargetSize(sw, sh);
  const input = new Float32Array((base64ToBytes(request.inputBase64).buffer as ArrayBuffer).slice(0));
  const source = device.createTexture({ label: "r2-input", size: { width: sw, height: sh }, format: "r32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  // writeTexture 的数据布局按 bytesPerRow（256）对齐：上传缓冲必须逐行填充，不能传紧凑数组。
  const upload = new Uint8Array(rowPadding(sw * 4) * sh);
  const compact = new Uint8Array(input.buffer);
  for (let row = 0; row < sh; row++) {
    upload.set(compact.subarray(row * sw * 4, (row + 1) * sw * 4), row * rowPadding(sw * 4));
  }
  device.queue.writeTexture({ texture: source }, upload,
    { bytesPerRow: rowPadding(sw * 4), rowsPerImage: sh }, { width: sw, height: sh });
  const target = device.createTexture({ label: "r2-output", size: { width: tw, height: th }, format: "r32float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
  const uniform = device.createBuffer({ label: "r2-uniform", size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniform, 0, new Uint32Array([sw, sh, tw, th]));
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: source.createView() }, { binding: 1, resource: target.createView() },
    { binding: 2, resource: uniform },
  ] });
  const readBytes = rowPadding(tw * 4);
  const readback = device.createBuffer({ label: "r2-readback", size: readBytes * th,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  const repeats: string[] = [];
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      const encoder = device.createCommandEncoder({ label: `r2-run-${repeat}` });
      const pass = encoder.beginComputePass({ label: options.subgroup ? "r2-hiz-first-stage-subgroup" : "r2-hiz-first-stage" });
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
      // subgroup 变体 workgroup 为 (2,16)：x 每 texel 列一个 workgroup，y 每 8 个 texel 行一个。
      if (options.subgroup) {
        const [, dispatchY] = hiZFirstStageSubgroupDispatchSize(sw, sh);
        pass.dispatchWorkgroups(tw, dispatchY);
      } else {
        pass.dispatchWorkgroups(Math.ceil(tw / 8), Math.ceil(th / 8));
      }
      pass.end();
      encoder.copyTextureToBuffer({ texture: target },
        { buffer: readback, bytesPerRow: readBytes, rowsPerImage: th }, { width: tw, height: th });
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const packed = new Uint8Array(readBytes * th);
      packed.set(new Uint8Array(readback.getMappedRange() as ArrayBuffer));
      readback.unmap();
      const output = new Float32Array(tw * th);
      for (let row = 0; row < th; row++) {
        output.set(new Float32Array(packed.buffer, row * readBytes, tw), row * tw);
      }
      repeats.push(bytesToBase64(new Uint8Array(output.buffer)));
    }
  } finally {
    source.destroy(); target.destroy(); uniform.destroy(); readback.destroy();
  }
  return { repeatsBase64: [repeats[0]!, repeats[1]!], validationMessages: [] };
}

export async function runR2ShaderIrProbe(requests: readonly R2CaseRequest[]): Promise<R2ProbeResult> {
  const errors: string[] = [];
  // min/max 两个模式在 IR 层特化（真机发现 ANGLE/D3D11 对 uvec2+uint 混排 uniform 的打包 quirk）。
  const wgsl = {
    min: emitKernelWgsl(buildHiZFirstStageKernel(false)).code,
    max: emitKernelWgsl(buildHiZFirstStageKernel(true)).code,
    subMin: emitKernelWgsl(buildHiZFirstStageSubgroupKernel(false)).code,
    subMax: emitKernelWgsl(buildHiZFirstStageSubgroupKernel(true)).code,
  };
  const hasSubgroupCases = requests.some((request) => request.webgpuOnly === true);
  const glsl = { min: emitKernelGlsl(buildHiZFirstStageKernel(false)), max: emitKernelGlsl(buildHiZFirstStageKernel(true)) };
  let webgpu: R2ProbeResult["webgpu"];
  let webgl: R2ProbeResult["webgl"];

  try {
    if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("requestAdapter returned null.");
    // subgroup 案例在 adapter 层声明意图；真机结论（本 runner 首跑）：headless Chrome 153 的
    // adapter.features 可能声明 subgroups 但 device 实际未启用（Tint 拒绝 `requires subgroups;`），
    // 因此以 requestDevice 之后的 device.features 为准做可探测拒绝，且 subgroup 腿
    // 独立 error scope，绝不毒化 legacy WebGPU 案例。
    const adapterSubgroups = adapter.features.has("subgroups");
    const device = await adapter.requestDevice({ label: "r2-shader-ir-probe",
      requiredFeatures: adapterSubgroups && hasSubgroupCases ? ["subgroups"] : [] });
    device.addEventListener?.("uncapturederror", (event) => { errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`); });
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    const validationMessages: string[] = [];
    const modules: Record<string, GPUShaderModule> = {
      min: device.createShaderModule({ label: "r2-hiz-first-stage-min", code: wgsl.min }),
      max: device.createShaderModule({ label: "r2-hiz-first-stage-max", code: wgsl.max }),
    };
    const entryPoints: Record<string, string> = { min: "hi_z_first_stage", max: "hi_z_first_stage" };
    // legacy 腿先行：module + pipeline 建立并验证（任何 subgroup 问题在此前不参与）。
    device.pushErrorScope("validation");
    const pipelines: Record<string, GPUComputePipeline> = {};
    for (const key of ["min", "max"]) {
      pipelines[key] = device.createComputePipeline({ label: `r2-${key}`, layout: "auto",
        compute: { module: modules[key]!, entryPoint: entryPoints[key]! } });
    }
    const legacyValidation = await device.popErrorScope();
    if (legacyValidation) throw new Error(`WebGPU validation error: ${legacyValidation.message}`);

    // subgroup 腿（隔离）：device.features 实际启用才建 module；失败降级为案例缺席+原因。
    let deviceSubgroups = false;
    let subgroupSkipReason = "adapter does not expose the subgroups feature";
    if (hasSubgroupCases) {
      if (device.features.has("subgroups")) {
        try {
          device.pushErrorScope("validation");
          modules.subMin = device.createShaderModule({ label: "r2-hiz-first-stage-subgroup-min", code: wgsl.subMin });
          modules.subMax = device.createShaderModule({ label: "r2-hiz-first-stage-subgroup-max", code: wgsl.subMax });
          entryPoints.subMin = "hi_z_first_stage_subgroup";
          entryPoints.subMax = "hi_z_first_stage_subgroup";
          for (const key of ["subMin", "subMax"]) {
            pipelines[key] = device.createComputePipeline({ label: `r2-${key}`, layout: "auto",
              compute: { module: modules[key]!, entryPoint: entryPoints[key]! } });
          }
          const subgroupValidation = await device.popErrorScope();
          if (subgroupValidation) throw new Error(subgroupValidation.message);
          deviceSubgroups = true;
        } catch (subgroupError) {
          errors.push(`subgroup-leg: ${subgroupError instanceof Error ? subgroupError.message : String(subgroupError)}`);
          subgroupSkipReason = "subgroup module/pipeline creation failed on device (see probeErrors)";
        }
      } else {
        subgroupSkipReason = "device did not enable the subgroups feature (adapter declared it; device.features is authoritative)";
      }
    }

    for (const [mode, module] of Object.entries(modules)) {
      for (const message of (await module.getCompilationInfo()).messages) {
        if (message.type !== "info") validationMessages.push(`${mode}:${message.type}:${message.lineNum}:${message.message}`);
      }
    }
    const cases: Record<string, R2BackendCaseResult> = {};
    for (const request of requests) {
      if (request.webgpuOnly && !deviceSubgroups) {
        cases[request.name] = { repeatsBase64: ["", ""], validationMessages: [], skippedReason: subgroupSkipReason };
        continue;
      }
      cases[request.name] = await runWebGpuCase(device, pipelines, request, { subgroup: request.webgpuOnly === true });
    }
    webgpu = {
      adapter: {
        vendor: info?.vendor ?? "", architecture: info?.architecture ?? "", device: info?.device ?? "",
        description: info?.description ?? "",
      },
      features: [...adapter.features].sort(),
      subgroupsFeature: deviceSubgroups,
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
    const programs = { min: linkProgram(glsl.min.fragment), max: linkProgram(glsl.max.fragment) };
    const diagnosticProgram = gl.createProgram()!;
    gl.attachShader(diagnosticProgram, compileShader(gl, gl.VERTEX_SHADER, DCIR_GLSL_VERTEX));
    gl.attachShader(diagnosticProgram, compileShader(gl, gl.FRAGMENT_SHADER, DIAGNOSTIC_FRAGMENT));
    gl.linkProgram(diagnosticProgram);
    if (!gl.getProgramParameter(diagnosticProgram, gl.LINK_STATUS)) {
      throw new Error(`diagnostic program link failed: ${gl.getProgramInfoLog(diagnosticProgram) ?? "no log"}`);
    }
    const cases: Record<string, R2BackendCaseResult> = {};
    if (floatExt) for (const request of requests) {
      // subgroup 内核无 GLSL 发射（emitKernelGlsl fail-closed）；WebGL2 侧按缺席+原因记录。
      if (request.webgpuOnly) {
        cases[request.name] = { repeatsBase64: ["", ""], validationMessages: [],
          skippedReason: "subgroup kernels are WebGPU-only; GLSL emission fails closed" };
        continue;
      }
      cases[request.name] = runWebGlCase(gl, programs, diagnosticProgram, request);
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
