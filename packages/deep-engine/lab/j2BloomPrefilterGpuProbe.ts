/// <reference types="@webgpu/types" />
import { BLOOM_WGSL } from "../src/postprocess/bloomWgsl.js";
import { BLOOM_PREFILTER_WGSL } from "../src/postprocess/bloomPrefilterWgsl.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

// Frozen before measurement. GPU before/after is absolute; CPU reference is relative.
const GPU_TOLERANCE = 0.000001, CPU_RELATIVE_TOLERANCE = 0.000001;
const f = Math.fround;
const CASES = [
  { id: "black-zero-threshold", color: [0, 0, 0], threshold: 0, softKnee: 0 },
  { id: "positive-zero-threshold", color: [.25, .1, .05], threshold: 0, softKnee: .5 },
  { id: "zero-knee-below", color: [.999999, .2, .1], threshold: 1, softKnee: 0 },
  { id: "zero-knee-at", color: [1, .2, .1], threshold: 1, softKnee: 0 },
  { id: "zero-knee-above", color: [1.000001, .2, .1], threshold: 1, softKnee: 0 },
  { id: "soft-below", color: [.75, .2, .1], threshold: 1, softKnee: .5 },
  { id: "soft-at", color: [1, .2, .1], threshold: 1, softKnee: .5 },
  { id: "soft-above", color: [1.25, .2, .1], threshold: 1, softKnee: .5 },
  { id: "knee-lower-edge", color: [.5, .2, .1], threshold: 1, softKnee: .5 },
  { id: "knee-upper-edge", color: [1.5, .2, .1], threshold: 1, softKnee: .5 },
  { id: "tiny-knee", color: [1, .2, .1], threshold: 1, softKnee: .0000001 },
  { id: "green-max", color: [.1, 2, .2], threshold: 1, softKnee: 1 },
  { id: "blue-max", color: [.1, .2, 2], threshold: 1, softKnee: 1 },
  { id: "negative-channels", color: [-2, .25, -.1], threshold: .5, softKnee: .5 },
  { id: "hdr", color: [64, 8, 2], threshold: 4, softKnee: .75 },
  { id: "hdr-half-max", color: [65504, 16, 1], threshold: 64, softKnee: .5 },
];
type Profile = "ts-max-rgb" | "native-max-rgb";

function fnBody(source: string, marker: string): string {
  const start = source.indexOf(marker), open = source.indexOf("{", start);
  if (start < 0 || open < 0) throw Error(`Missing production function ${marker}`);
  let depth = 1, cursor = open + 1;
  for (; cursor < source.length && depth > 0; cursor++) {
    if (source[cursor] === "{") depth++;
    else if (source[cursor] === "}") depth--;
  }
  if (depth !== 0) throw Error(`Unclosed production function ${marker}`);
  return source.slice(open + 1, cursor - 1);
}

export function bloomPrefilterArithmeticForProbe(source: string, profile: Profile): string {
  if (profile === "ts-max-rgb") return `fn actual(color: vec3f) -> vec3f {${fnBody(source, "fn extract(")}}`;
  const body = fnBody(source, "fn fragment_prefilter(");
  const start = body.indexOf("  let brightness =");
  if (start < 0 || !body.includes("return vec4f(color * contribution, 1.0);")) {
    throw Error("Native production arithmetic boundary changed");
  }
  return `fn actualNative(color: vec3f) -> vec4f {${body.slice(start)}}
fn actual(input: vec3f) -> vec3f { return actualNative(max(input, vec3f(0))).rgb; }`;
}

export function bloomPrefilterCpuReference(test: typeof CASES[number], profile: Profile): number[] {
  const positive = test.color.map(value => Math.max(f(value), 0));
  const brightness = Math.max(...positive), threshold = f(test.threshold);
  let knee = f(threshold * f(test.softKnee)), soft = 0;
  if (profile === "native-max-rgb") knee = Math.max(knee, f(.00001));
  if (knee > 0) {
    const transition = Math.min(Math.max(f(f(brightness - threshold) + knee), 0), f(2 * knee));
    const denominator = f(f(4 * knee) + (profile === "native-max-rgb" ? f(.00001) : 0));
    soft = f(f(transition * transition) / denominator);
  }
  const contribution = f(Math.max(f(brightness - threshold), soft) / Math.max(brightness, f(.00001)));
  return positive.map(channel => f(channel * contribution));
}

export async function runJ2BloomPrefilterGpuProbe(input: {
  oldTs: string; oldNative: string; currentNative: string; canonical: string; baselineCommit: string;
}) {
  if (input.canonical !== BLOOM_PREFILTER_WGSL) throw Error("Canonical/generated source mismatch");
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw Error("Hardware WebGPU adapter unavailable");
  const device = await adapter.requestDevice(), errors: string[] = [];
  const results: Array<{ profile: Profile; id: string; color: number[]; threshold: number; softKnee: number;
    old: number[]; value: number[]; reference: number[]; beforeAfterError: number; cpuRelativeError: number;
    exact: boolean; sourceHash: string; baselineSourceHash: string; shaderHashes: string[]; passed: boolean }> = [];
  device.addEventListener("uncapturederror", event => errors.push(event.error.message));
  try {
    for (const profile of ["ts-max-rgb", "native-max-rgb"] as const) {
      const current = profile === "ts-max-rgb" ? BLOOM_WGSL : input.currentNative;
      const before = profile === "ts-max-rgb" ? input.oldTs : input.oldNative;
      const outputs: number[][][] = [];
      const hashes: string[] = [];
      for (const [phase, source] of [["before", before], ["after", current]] as const) {
        const code = `${phase === "after" ? input.canonical : ""}
struct Params { threshold: f32, softKnee: f32, intensity: f32, padding: f32 };
struct NativeParams { threshold: f32, soft_knee: f32, radius: f32, padding: f32 };
var<private> bloomParams: Params;
var<private> bloom: NativeParams;
${bloomPrefilterArithmeticForProbe(source, profile)}
@group(0) @binding(0) var<storage,read> inputs: array<vec4f>;
@group(0) @binding(1) var<storage,read_write> values: array<vec4f>;
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id: vec3u) {
  let parameters = inputs[id.x * 2u + 1u];
  bloomParams.threshold = parameters.x; bloomParams.softKnee = parameters.y;
  bloom.threshold = parameters.x; bloom.soft_knee = parameters.y;
  values[id.x] = vec4f(actual(inputs[id.x * 2u].xyz), 1);
}`;
        hashes.push(sha256Utf8(code));
        const owned: GPUBuffer[] = [];
        device.pushErrorScope("validation");
        try {
          const pipeline = await device.createComputePipelineAsync({ layout: "auto",
            compute: { module: device.createShaderModule({ code }), entryPoint: "probe" } });
          const bytes = CASES.length * 16;
          const sourceBuffer = device.createBuffer({ size: bytes * 2,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); owned.push(sourceBuffer);
          const target = device.createBuffer({ size: bytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }); owned.push(target);
          const readback = device.createBuffer({ size: bytes,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); owned.push(readback);
          device.queue.writeBuffer(sourceBuffer, 0, new Float32Array(CASES.flatMap(test =>
            [...test.color, 0, test.threshold, test.softKnee, 0, 0])));
          const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: sourceBuffer } }, { binding: 1, resource: { buffer: target } }] });
          const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(CASES.length); pass.end();
          encoder.copyBufferToBuffer(target, 0, readback, 0, bytes); device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const values = new Float32Array(readback.getMappedRange()).slice(); readback.unmap();
          outputs.push(CASES.map((_, index) => Array.from(values.slice(index * 4, index * 4 + 3))));
        } finally {
          const error = await device.popErrorScope(); if (error) errors.push(error.message);
          for (const buffer of owned.reverse()) buffer.destroy();
        }
      }
      CASES.forEach((test, index) => {
        const old = outputs[0]![index]!, value = outputs[1]![index]!, reference = bloomPrefilterCpuReference(test, profile);
        const beforeAfterError = Math.max(...value.map((channel, axis) => Math.abs(channel - old[axis]!)));
        const cpuRelativeError = Math.max(...value.map((channel, axis) =>
          Math.abs(channel - reference[axis]!) / Math.max(1, Math.abs(reference[axis]!))));
        const finite = [...old, ...value, ...reference].every(Number.isFinite);
        results.push({ profile, ...test, old, value, reference, beforeAfterError, cpuRelativeError,
          exact: value.every((channel, axis) => channel === old[axis]),
          sourceHash: sha256Utf8(current), baselineSourceHash: sha256Utf8(before), shaderHashes: hashes,
          passed: finite && beforeAfterError <= GPU_TOLERANCE && cpuRelativeError <= CPU_RELATIVE_TOLERANCE });
      });
    }
    return { passed: errors.length === 0 && results.every(row => row.passed), results, errors,
      scope: "finite max-RGB arithmetic; retained TS/Native knee and denominator policies",
      excluded: ["Native host execution", "texture sampling", "blur/pyramid", "full-frame parity", "GPU timing"],
      baselineCommit: input.baselineCommit, canonicalHash: sha256Utf8(input.canonical),
      gpuAbsoluteTolerance: GPU_TOLERANCE, cpuRelativeTolerance: CPU_RELATIVE_TOLERANCE,
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture } };
  } finally { device.destroy(); }
}
