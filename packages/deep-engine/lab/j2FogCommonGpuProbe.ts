/// <reference types="@webgpu/types" />
import { FOG_OPTICAL_DEPTH_WGSL } from "../src/fog/fogOpticalDepthWgsl.js";
import { VOLUMETRIC_FOG_MARCH_WGSL } from "../src/fog/volumetricFogPassWgsl.js";
import { PBR_FOG_WGSL } from "../src/webgpu/pbrFogWgsl.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

const GPU_TOLERANCE = 0.000001, CPU_RELATIVE_TOLERANCE = 0.000001;
type Profile = "ts-volumetric" | "ts-author" | "native-fog" | "native-bloom-fog";
const CASES = [-2, 0, 2, 64].flatMap(height => [0, .001, 1, 8].flatMap(base =>
  [.5, 64].flatMap(scale => [.125, 8].flatMap(step => [1, 2].map(mode =>
    ({ height, base, scale, step, mode }))))));
type ProbeInput = { baselineCommit: string; canonical: string; oldVolume: string; oldAuthor: string;
  oldNativeFog: string; oldNativeBloomFog: string; nativeFog: string; nativeBloomFog: string };

function statement(source: string, name: string): string {
  const result = source.match(new RegExp(`(?:let|var) ${name} = ([^;]+);`));
  if (!result?.[1]) throw Error(`Production statement ${name} missing`);
  return result[1];
}
function fnReturn(source: string, name: string): string {
  const result = source.match(new RegExp(`fn ${name}\\([^}]+return ([^;]+);`));
  if (!result?.[1]) throw Error(`Production function ${name} missing`);
  return result[1];
}
function nativeParameters(expression: string): string {
  return expression.replaceAll("frame.tuning.w", "baseExtinction")
    .replaceAll("frame.fogProfile.y", "scaleHeight").replaceAll("frame.fogProjection.z", "mode");
}
export function fogArithmeticForProbe(source: string, profile: Profile): string {
  if (profile === "ts-volumetric") return `
    let density = ${fnReturn(source, "densityAtHeight")};
    let opticalDepth = density * stepDistance;
    let transmittance = ${statement(source, "extinction")};
    return vec4f(density, transmittance, 0.0, 1.0);`;
  if (profile === "ts-author") {
    const exp2 = Array.from(source.matchAll(/factor = ([^;]+);/g))
      .map(match => match[1]).find(value => value?.includes("opticalDepth"));
    if (!exp2 || !exp2.includes("opticalDepth")) throw Error("Author exp2 boundary changed");
    const step = source.match(/transmittance \*= ([^;]+);/)?.[1];
    if (!step) throw Error("Author eight-step boundary changed");
    return `let opticalDepth = baseExtinction * height;
      let stepDepth = opticalDepth / 8.0; var transmittance = 1.0;
      for (var step = 0; step < 8; step++) { transmittance *= ${step}; }
      return vec4f(0.0, transmittance, ${exp2}, 1.0);`;
  }
  return `let sample_height = height; let step_distance = stepDistance;
    let density = ${nativeParameters(statement(source, "density"))};
    let step_transmittance = ${statement(source, "step_transmittance")};
    let optical_depth = density * step_distance;
    let metric = ${nativeParameters(statement(source, "metric"))};
    let amount = ${statement(source, "amount")};
    return vec4f(density, step_transmittance, amount, 1.0);`;
}
function reference(test: typeof CASES[number], profile: Profile): number[] {
  const f = Math.fround, height = f(test.height), base = f(test.base), scale = f(test.scale);
  if (profile === "ts-author") {
    const optical = f(base * height), perStep = f(Math.exp(-f(optical / 8)));
    let transmittance = 1;
    for (let i = 0; i < 8; i++) transmittance = f(transmittance * perStep);
    return [0, transmittance, f(1 - f(Math.exp(-f(optical * optical)))), 1];
  }
  const density = f(base * f(Math.exp(f(-Math.max(height, 0) / scale))));
  const optical = f(density * f(test.step)), transmittance = f(Math.exp(-optical));
  const metric = test.mode === 2 ? f(optical * optical) : optical;
  return [density, transmittance, profile === "ts-volumetric" ? 0 :
    Math.min(Math.max(f(1 - f(Math.exp(-metric))), 0), 1), 1];
}

export async function runJ2FogCommonGpuProbe(input: ProbeInput) {
  if (input.canonical !== FOG_OPTICAL_DEPTH_WGSL) throw Error("Canonical/generated source mismatch");
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw Error("Actual WebGPU adapter unavailable");
  const device = await adapter.requestDevice(), errors: string[] = [];
  device.addEventListener("uncapturederror", event => errors.push(event.error.message));
  const results: Array<{ profile: Profile; index: number; input: typeof CASES[number]; old: number[];
    value: number[]; reference: number[]; beforeAfterError: number; cpuRelativeError: number;
    exact: boolean; sourceHash: string; baselineSourceHash: string; shaderHashes: string[]; passed: boolean }> = [];
  const sources: Array<[Profile, string, string]> = [
    ["ts-volumetric", input.oldVolume, VOLUMETRIC_FOG_MARCH_WGSL],
    ["ts-author", input.oldAuthor, PBR_FOG_WGSL],
    ["native-fog", input.oldNativeFog, input.nativeFog],
    ["native-bloom-fog", input.oldNativeBloomFog, input.nativeBloomFog],
  ];
  try {
    for (const [profile, before, current] of sources) {
      const outputs: number[][][] = [], hashes: string[] = [];
      for (const [phase, source] of [["before", before], ["after", current]] as const) {
        const code = `${phase === "after" ? input.canonical : ""}
fn actual(height: f32, baseExtinction: f32, scaleHeight: f32, stepDistance: f32, mode: f32) -> vec4f {
  ${fogArithmeticForProbe(source, profile)}
}
@group(0) @binding(0) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outputs: array<vec4f>;
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id: vec3u) {
  let p = inputs[id.x * 2u];
  outputs[id.x] = actual(p.x, p.y, p.z, p.w, inputs[id.x * 2u + 1u].x);
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
            [test.height, test.base, test.scale, test.step, test.mode, 0, 0, 0])));
          const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: sourceBuffer } }, { binding: 1, resource: { buffer: target } }] });
          const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(CASES.length); pass.end();
          encoder.copyBufferToBuffer(target, 0, readback, 0, bytes); device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const values = new Float32Array(readback.getMappedRange()).slice(); readback.unmap();
          outputs.push(CASES.map((_, i) => Array.from(values.slice(i * 4, i * 4 + 4))));
        } finally {
          const error = await device.popErrorScope(); if (error) errors.push(error.message);
          owned.forEach(buffer => buffer.destroy());
        }
      }
      CASES.forEach((test, index) => {
        const old = outputs[0]![index]!, value = outputs[1]![index]!, expected = reference(test, profile);
        const beforeAfterError = Math.max(...value.map((v, i) => Math.abs(v - old[i]!)));
        const cpuRelativeError = Math.max(...value.map((v, i) => Math.abs(v - expected[i]!) / Math.max(1, Math.abs(expected[i]!))));
        results.push({ profile, index, input: test, old, value, reference: expected, beforeAfterError, cpuRelativeError,
          exact: value.every((v, i) => v === old[i]), sourceHash: sha256Utf8(current), baselineSourceHash: sha256Utf8(before),
          shaderHashes: hashes, passed: [...old, ...value].every(Number.isFinite) &&
            beforeAfterError <= GPU_TOLERANCE && cpuRelativeError <= CPU_RELATIVE_TOLERANCE });
      });
    }
    return { passed: errors.length === 0 && results.every(row => row.passed), results, errors,
      baselineCommit: input.baselineCommit, canonicalHash: sha256Utf8(input.canonical),
      gpuAbsoluteTolerance: GPU_TOLERANCE, cpuRelativeTolerance: CPU_RELATIVE_TOLERANCE,
      scope: "finite height-density/Beer math; original TS/Native mode and step policies",
      excluded: ["Native host execution", "HG normalization", "camera/world transforms", "full-frame parity", "timing"],
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture } };
  } finally { device.destroy(); }
}
