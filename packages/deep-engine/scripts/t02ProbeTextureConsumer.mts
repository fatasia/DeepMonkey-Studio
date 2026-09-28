import { PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL } from "../src/lighting/probeClipmapTextureSamplingWgsl.ts";
import { DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES } from "../src/lighting/probeClipmapTextureSamplingWgsl.ts";
import { t02ProbeTextureSamplingKernel } from "./t02ProbeTextureSamplingPageKernel.mjs";
import { GRID, toBase64 } from "./t02ProbePrep.mts";

/**
 * T02 真实渲染采样路径核对：production textureLoad 消费 GPU producer 捕获纹理。
 * 生产纹理缺失 meanDistance/variance，仅验证 validity 拒绝分支；存储记录路径
 * 的 Chebyshev 测量需在证据中与本路径分开报告，禁止用存储路径冒充生产消费。
 */
export async function runT02ProductionTextureConsumer(page: {
  evaluate<T, A>(fn: (arg: A) => Promise<T>, arg: A): Promise<T>;
}, captureHalfB64: string, buried: readonly number[],
  receivers: readonly { position: readonly [number, number, number]; normal: readonly [number, number, number] }[],
  receiverBytes: Float32Array, truth: readonly (readonly [number, number, number])[],
  positions: readonly (readonly [number, number, number])[]) {
  const captured = Buffer.from(captureHalfB64, "base64");
  const admitted = Buffer.from(captured);
  const rejected = Buffer.from(captured);
  const allValid = new DataView(admitted.buffer, admitted.byteOffset, admitted.byteLength);
  const texelOffset = (index: number): number => {
    const x = index % GRID[0]!, y = Math.floor(index / GRID[0]!) % GRID[1]!,
      z = Math.floor(index / (GRID[0]! * GRID[1]!));
    return z * 256 * GRID[1]! + y * 256 + x * 8;
  };
  // Compare an intentionally all-valid counterfactual with the unmodified producer alpha.
  for (let index = 0; index < positions.length; index++) allValid.setUint16(texelOffset(index) + 6, 0x3c00, true);
  // rejected is a byte-for-byte capture readback: no manual wall alpha overrides.
  const rawView = new DataView(captured.buffer, captured.byteOffset, captured.byteLength);
  const producerBuriedAlpha = buried.map(index => rawView.getUint16(texelOffset(index) + 6, true));
  const producerValidCount = positions.filter((_, index) =>
    rawView.getUint16(texelOffset(index) + 6, true) === 0x3c00).length;
  const meta = new ArrayBuffer(DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES);
  const floats = new Float32Array(meta), uints = new Uint32Array(meta), ints = new Int32Array(meta);
  floats.set([1, 1, 1, 1], 0);
  uints.set([GRID[0], GRID[1], GRID[2], 0], 4);
  ints.set([0, 0, 0], 8); uints[11] = 0;
  floats.set([GRID[0], GRID[1], GRID[2]], 12); uints[15] = positions.length;
  const driver = `
struct T02Receiver { position: vec4f, normal: vec4f };
@group(0) @binding(0) var<storage, read> t02Receivers: array<T02Receiver>;
@group(0) @binding(1) var<storage, read_write> t02Outputs: array<vec4f>;
@compute @workgroup_size(64)
fn t02_sample_texture_receivers(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= arrayLength(&t02Receivers)) { return; }
  let receiver = t02Receivers[gid.x];
  t02Outputs[gid.x] = deepGiSampleTexture(receiver.position.xyz, receiver.normal.xyz);
}
`;
  const gpu = await page.evaluate(t02ProbeTextureSamplingKernel, {
    wgsl: PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL + driver,
    levelsB64: toBase64(meta), receiversB64: toBase64(receiverBytes),
    textureSetsB64: [toBase64(admitted), toBase64(rejected)], receiverCount: receivers.length,
  });
  const samples = gpu.values.map(value => {
    const bytes = Buffer.from(value, "base64");
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, receivers.length * 4);
    return receivers.map((_, index) => [floats[index * 4]!, floats[index * 4 + 1]!,
      floats[index * 4 + 2]!] as [number, number, number]);
  });
  const referenceAt = (receiver: typeof receivers[number]): number => {
    const index = positions.findIndex(position => position[0] === Math.round(receiver.position[0])
      && position[1] === receiver.position[1] && position[2] === Math.round(receiver.position[2]));
    if (index < 0) throw new Error("No truth sample for texture receiver.");
    return truth[index]![0]!;
  };
  const errors = samples.map(field => field.map((value, index) =>
    Math.abs(value[0] - referenceAt(receivers[index]!))).filter((_, index) => index % 2 === 0));
  const average = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const awayDelta = Math.max(...receivers.flatMap((_, index) => index % 2 === 0 ? [] :
    [0, 1, 2].map(axis => Math.abs(samples[0]![index]![axis]! - samples[1]![index]![axis]!))));
  return { meanAdmittedError: average(errors[0]!), meanRejectedError: average(errors[1]!),
    maxFacingAwayDelta: awayDelta, queueErrors: gpu.errors, shaderMessages: gpu.messages,
    producerBuriedAlpha, producerValidCount,
    rgbaAlphaSource: "production GPU capture unchanged; admitted counterfactual forces alpha=1",
    distanceVarianceAvailable: false,
    receivers: receivers.map((receiver, index) => ({ ...receiver,
      admitted: samples[0]![index], rejected: samples[1]![index] })) };
}
