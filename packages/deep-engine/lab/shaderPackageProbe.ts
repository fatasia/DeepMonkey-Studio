import { buildDeepShaderPackage, type ShaderPackagePassBuildInput } from "@bim-studio/deep-engine/shader-package";
import { ShaderPackageExecutor, type PreparedShaderPackagePass } from "@bim-studio/deep-engine/webgpu";

const WIDTH = 8;
const HEIGHT = 8;
const BYTES_PER_ROW = 256;
const EXPECTED_PIXEL = Object.freeze([0.125, 0.5, 0.875, 1] as const);
const CLEAR_PIXEL = Object.freeze([0.003, 0.007, 0.011, 1] as const);

/**
 * Keep this probe on the frozen mesh-v1 ABI. The renderer's default scene shader has a
 * newer frame block, so using it here would accidentally test an ABI mismatch instead of
 * the package executor itself.
 */
const PACKAGE_SHADER = /* wgsl */ `
struct Frame {
  view: mat4x4f, light: mat4x4f, eye: vec4f, background: vec4f,
  floor: vec4f, lightDirection: vec4f, tuning: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;

struct Input {
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
  @location(5) normal0: vec4f, @location(6) normal1: vec4f, @location(7) normal2: vec4f,
  @location(8) colorMetal: vec4f, @location(9) material: vec4f,
  @location(10) uv0: vec2f, @location(12) emissiveAlpha: vec4f, @location(13) uv1: vec2f,
};

fn worldPosition(input: Input) -> vec4f {
  let local = vec4f(input.position, 1.0);
  return vec4f(dot(input.row0, local), dot(input.row1, local), dot(input.row2, local), 1.0);
}
@vertex fn vertexMain(input: Input) -> @builtin(position) vec4f {
  return frame.view * worldPosition(input);
}
@vertex fn shadowMain(input: Input) -> @builtin(position) vec4f {
  return frame.light * worldPosition(input);
}
@fragment fn fragmentMain() -> @location(0) vec4f {
  return vec4f(0.125, 0.5, 0.875, 1.0);
}`;

const DRAW_SHADER = /* wgsl */ `
struct Frame {
  view: mat4x4f, light: mat4x4f, eye: vec4f, background: vec4f,
  floor: vec4f, lightDirection: vec4f, tuning: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;

struct Input {
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
  @location(5) normal0: vec4f, @location(6) normal1: vec4f, @location(7) normal2: vec4f,
  @location(8) colorMetal: vec4f, @location(9) material: vec4f,
  @location(10) uv0: vec2f, @location(12) emissiveAlpha: vec4f, @location(13) uv1: vec2f,
};

@vertex fn vertexMain(input: Input) -> @builtin(position) vec4f {
  return vec4f(input.position, 1.0);
}

@fragment fn fragmentMain() -> @location(0) vec4f {
  return vec4f(0.125 + frame.tuning.x * 0.0, 0.5, 0.875, 1.0);
}`;

function pass(passId: "forward" | "shadow"): ShaderPackagePassBuildInput {
  const module = { label: "Deep Lab frozen ABI package probe", code: PACKAGE_SHADER };
  if (passId === "forward") return {
    techniqueId: "pbr", passId, kind: "forward", module,
    entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
    pipeline: {
      passVariantId: "forward-plain", attachmentProfileId: "forward-opaque",
      alphaMode: "OPAQUE", rasterMode: "ccw",
    },
  };
  return {
    techniqueId: "pbr", passId, kind: "shadow", module,
    entryPoints: { vertex: "shadowMain", fragment: null },
    pipeline: {
      passVariantId: "shadow-solid", attachmentProfileId: "shadow",
      alphaMode: "OPAQUE", rasterMode: "ccw",
    },
  };
}

export function buildDrawProbePackage() {
  return buildDeepShaderPackage({
    packageId: "deep.lab.package-draw-probe",
    packageVersion: "2.0.0",
    compilerVersion: "0.2.0",
    passes: [{
      techniqueId: "probe", passId: "forward", kind: "forward",
      module: { label: "Deep Lab package draw/readback probe", code: DRAW_SHADER },
      entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
      pipeline: {
        passVariantId: "forward-plain", attachmentProfileId: "forward-opaque",
        alphaMode: "OPAQUE", rasterMode: "double",
      },
    }],
  });
}

export function decodeFloat16Bits(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function evaluateDrawPixel(raw16: readonly number[]) {
  const pixel = raw16.map(decodeFloat16Bits);
  const maxAbsError = Math.max(...pixel.map((value, index) => Math.abs(value - EXPECTED_PIXEL[index]!)));
  const clearDistance = Math.max(...pixel.map((value, index) => Math.abs(value - CLEAR_PIXEL[index]!)));
  return Object.freeze({
    raw16: Object.freeze([...raw16]), pixel: Object.freeze(pixel), expected: EXPECTED_PIXEL,
    maxAbsError, nonClear: clearDistance > 0.05,
    verified: maxAbsError <= 0.01 && clearDistance > 0.05,
  });
}

function createBuffer(device: GPUDevice, data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
  new Float32Array(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

function triangleGeometry(): Float32Array {
  return new Float32Array([
    -1, -1, 0, 0, 0, 1, 0, 0, 0, 0,
    3, -1, 0, 0, 0, 1, 1, 0, 1, 0,
    -1, 3, 0, 0, 0, 1, 0, 1, 0, 1,
  ]);
}

function identityInstance(): Float32Array {
  const data = new Float32Array(36);
  data.set([1, 0, 0, 0], 0); data.set([0, 1, 0, 0], 4); data.set([0, 0, 1, 0], 8);
  data.set([1, 0, 0, 0], 12); data.set([0, 1, 0, 0], 16); data.set([0, 0, 1, 0], 20);
  data.set([1, 1, 1, 0], 24); data.set([1, 0.5, 1, 0], 28); data.set([0, 0, 0, 1], 32);
  return data;
}

async function drawAndReadback(device: GPUDevice, prepared: PreparedShaderPackagePass) {
  const buffers: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const texture = (descriptor: GPUTextureDescriptor): GPUTexture => {
    const value = device.createTexture(descriptor); textures.push(value); return value;
  };
  const buffer = (data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer => {
    const value = createBuffer(device, data, usage); buffers.push(value); return value;
  };
  device.pushErrorScope("validation");
  let scopeOpen = true;
  try {
    if (!prepared.resolveRequired || prepared.attachmentProfile.sampleCount !== 4) {
      throw new Error("Draw probe requires the frozen forward ABI's 4x MSAA resolve path.");
    }
    const colorMsaa = texture({
      size: [WIDTH, HEIGHT], format: "rgba16float", sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const colorResolve = texture({
      size: [WIDTH, HEIGHT], format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const depth = texture({
      size: [WIDTH, HEIGHT], format: "depth24plus", sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const shadow = texture({
      size: [1, 1], format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const environment = texture({
      size: [1, 1, 6], dimension: "2d", format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const brdf = texture({
      size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const frame = buffer(new Float32Array(52), GPUBufferUsage.UNIFORM);
    const geometry = buffer(triangleGeometry(), GPUBufferUsage.VERTEX);
    const instance = buffer(identityInstance(), GPUBufferUsage.VERTEX);
    const readback = device.createBuffer({
      size: BYTES_PER_ROW * HEIGHT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(readback);
    const comparisonSampler = device.createSampler({ compare: "less-equal" });
    const environmentSampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    const frameGroup = device.createBindGroup({ layout: prepared.bindGroupLayouts[0]!, entries: [
      { binding: 0, resource: { buffer: frame } }, { binding: 1, resource: shadow.createView() },
      { binding: 2, resource: comparisonSampler },
      { binding: 3, resource: environment.createView({ dimension: "cube" }) },
      { binding: 4, resource: environment.createView({ dimension: "cube" }) },
      { binding: 5, resource: brdf.createView() }, { binding: 6, resource: environmentSampler },
    ] });

    const encoder = device.createCommandEncoder({ label: "Deep package draw/readback probe" });
    const render = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorMsaa.createView(), resolveTarget: colorResolve.createView(),
        loadOp: "clear", storeOp: "discard",
        clearValue: { r: CLEAR_PIXEL[0], g: CLEAR_PIXEL[1], b: CLEAR_PIXEL[2], a: CLEAR_PIXEL[3] },
      }],
      depthStencilAttachment: {
        view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "discard", depthClearValue: 1,
      },
    });
    render.setPipeline(prepared.pipeline);
    render.setBindGroup(0, frameGroup);
    render.setVertexBuffer(0, geometry); render.setVertexBuffer(1, instance); render.draw(3, 1); render.end();
    encoder.copyTextureToBuffer(
      { texture: colorResolve },
      { buffer: readback, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
      [WIDTH, HEIGHT],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mapped = readback.getMappedRange();
    const offset = Math.floor(HEIGHT / 2) * BYTES_PER_ROW + Math.floor(WIDTH / 2) * 8;
    const view = new DataView(mapped, offset, 8);
    const raw16 = Array.from({ length: 4 }, (_, index) => view.getUint16(index * 2, true));
    const result = evaluateDrawPixel(raw16);
    readback.unmap();
    const validationError = await device.popErrorScope();
    scopeOpen = false;
    if (validationError) throw new Error(`WebGPU draw validation failed: ${validationError.message}`);
    if (!result.verified) throw new Error(`Package draw readback mismatch: ${result.pixel.map(value => value.toFixed(4)).join(", ")}.`);
    return Object.freeze({
      passId: prepared.id, cacheKey: prepared.cacheKey,
      dimensions: Object.freeze([WIDTH, HEIGHT] as const), colorFormat: "rgba16float" as const,
      sampleCount: prepared.attachmentProfile.sampleCount, resolveUsed: true,
      centerPixelLinear: result.pixel, expectedPixelLinear: result.expected,
      maxAbsError: result.maxAbsError, nonClear: result.nonClear, verified: result.verified,
    });
  } finally {
    if (scopeOpen) {
      try { await device.popErrorScope(); } catch { /* Preserve the original probe error. */ }
    }
    for (const value of buffers) value.destroy();
    for (const value of textures) value.destroy();
  }
}

export type ShaderPackageProbeRecord = Readonly<{
  action: "shader-package-executor"; success: boolean; packageCacheKey?: string;
  passes?: readonly Readonly<{
    id: string; cacheKey: string; sampleCount: number; resolveRequired: boolean; depthFormat: string;
  }>[];
  drawReadback?: Awaited<ReturnType<typeof drawAndReadback>>;
  failure?: Readonly<{ stage: "build" | "prepare" | "draw-readback"; message: string }>;
}>;

export async function verifyShaderPackageExecutor(device: GPUDevice): Promise<ShaderPackageProbeRecord> {
  let stage: NonNullable<ShaderPackageProbeRecord["failure"]>["stage"] = "build";
  const executor = new ShaderPackageExecutor(device);
  try {
    const built = buildDeepShaderPackage({
      packageId: "deep.lab.real-gpu-probe", packageVersion: "2.0.0",
      compilerVersion: "0.2.0", passes: [pass("forward"), pass("shadow")],
    });
    if (!built.success || !built.value) {
      throw new Error(`Shader Package v2 build failed: ${built.diagnostics.map(entry => entry.message).join("; ")}`);
    }
    stage = "prepare";
    const prepared = await executor.prepare(built.value);
    const drawPackage = buildDrawProbePackage();
    if (!drawPackage.success || !drawPackage.value) {
      stage = "build";
      throw new Error(`Draw package build failed: ${drawPackage.diagnostics.map(entry => entry.message).join("; ")}`);
    }
    const [drawPass] = (await executor.prepare(drawPackage.value, ["probe/forward"])).passes;
    if (!drawPass) throw new Error("Package executor did not return the selected draw pass.");
    stage = "draw-readback";
    const drawReadback = await drawAndReadback(device, drawPass);
    return Object.freeze({
      action: "shader-package-executor", success: true,
      packageCacheKey: built.value.packageCacheKey,
      passes: Object.freeze(prepared.passes.map(entry => Object.freeze({
        id: entry.id, cacheKey: entry.cacheKey, sampleCount: entry.attachmentProfile.sampleCount,
        resolveRequired: entry.resolveRequired, depthFormat: entry.attachmentProfile.depthAttachment.format,
      }))),
      drawReadback,
    });
  } catch (error) {
    return Object.freeze({
      action: "shader-package-executor", success: false,
      failure: Object.freeze({ stage, message: error instanceof Error ? error.message : String(error) }),
    });
  } finally {
    executor.dispose();
  }
}
