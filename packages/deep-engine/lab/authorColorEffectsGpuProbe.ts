import { PBR_AUTHOR_COLOR_EFFECTS_WGSL } from "../src/webgpu/pbrAuthorColorEffectsWgsl.js";
import { applyPbrAuthorColorEffects, packPbrAuthorColorEffects, type PbrAuthorColorEffects } from "../src/webgpu/pbrAuthorColorEffects.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

const colors = [[-.4, -.2, -.1], [.1, .4, 2], [-.1, .4, 2], [0, 0, 0], [1e-7, -1e-7, 0], [5, 20, 100]] as const;
const neutral = { hue: 0, saturation: 0, brightness: 0, contrast: 0 };
const cases: PbrAuthorColorEffects[] = [{}, { colorGrading: neutral },
  { colorGrading: { ...neutral, temperature: 1 } },
  { colorGrading: { ...neutral, temperature: -1, tint: 1 } },
  { colorGrading: { ...neutral, hue: 120, saturation: -.8, brightness: -.9, contrast: .4 } },
  { vignette: { darkness: 2.4 }, colorGrading: { ...neutral, tint: -.7, brightness: -.2 } }];

export async function runAuthorColorEffectsGpuProbe() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice(), errors: string[] = [];
  device.addEventListener("uncapturederror", event => errors.push(event.error.message));
  const size = colors.length * 16;
  const input = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const author = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.pushErrorScope("validation");
  try {
    device.queue.writeBuffer(input, 0, new Float32Array(colors.flatMap(color => [...color, 1])));
    const code = PBR_AUTHOR_COLOR_EFFECTS_WGSL + `
@group(0) @binding(0) var<storage, read> probeInput: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> probeOutput: array<vec4f>;
@compute @workgroup_size(1) fn probeMain(@builtin(global_invocation_id) id: vec3u) {
  let uv = vec2f(f32(id.x % 3u) / 2.0, f32(id.x / 3u));
  probeOutput[id.x] = vec4f(deepAuthorColor(probeInput[id.x].rgb, uv), 1.0);
}`;
    const module = device.createShaderModule({ code });
    const compilation = await module.getCompilationInfo();
    if (compilation.messages.some(message => message.type === "error")) throw new Error(JSON.stringify(compilation.messages));
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "probeMain" } });
    const groups = [device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] }),
    device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: author } }] })];
    let maxAbsoluteError = 0, maxScaledError = 0;
    const results = [];
    for (const effects of cases) {
      device.queue.writeBuffer(author, 0, packPbrAuthorColorEffects(effects));
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); groups.forEach((group, index) => pass.setBindGroup(index, group));
      pass.dispatchWorkgroups(colors.length); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, size);
      device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
      const rows = colors.map((color, index) => {
        const expected = applyPbrAuthorColorEffects(color, [index % 3 / 2, Math.floor(index / 3)], effects);
        const actual = Array.from(values.subarray(index * 4, index * 4 + 3));
        actual.forEach((value, channel) => {
          const error = Math.abs(value - expected[channel]!);
          maxAbsoluteError = Math.max(maxAbsoluteError, error);
          maxScaledError = Math.max(maxScaledError, error / Math.max(1, Math.abs(expected[channel]!)));
        });
        return { color, expected, actual };
      });
      results.push({ effects, rows });
    }
    const validation = await device.popErrorScope();
    if (validation) errors.push(validation.message);
    return { passed: maxScaledError < 2e-5 && errors.length === 0, rows: cases.length * colors.length,
      maxAbsoluteError, maxScaledError, sourceSha256: sha256Utf8(PBR_AUTHOR_COLOR_EFFECTS_WGSL),
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description }, errors, results };
  } finally { input.destroy(); output.destroy(); readback.destroy(); author.destroy(); device.destroy(); }
}
