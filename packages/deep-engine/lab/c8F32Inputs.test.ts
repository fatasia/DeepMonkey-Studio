import { it as test } from "vitest";
import assert from "node:assert/strict";
import { sceneShader } from "../src/webgpu/pbrShader.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { F32_INPUT_MODES, observeDeepF32Inputs } from "./c8F32InputsShader.js";
import { prepareF32InputObservation } from "./c8F32InputsProbe.js";
const originalEntry = sceneShader.match(/@fragment fn fragmentMainColor\([^]*?\n\}/)![0];
for (const mode of F32_INPUT_MODES) test(`actual ${mode} input retains original color and source ABI`, () => {
  const observed = observeDeepF32Inputs(mode);
  assert(observed.code.includes(originalEntry));
  assert(observed.code.includes("out.color = vec4f(color, coverage(v.emissiveAlpha.w, v.material));"));
  assert(observed.code.includes("out.witness = deepC8F32Inputs;"));
  assert.equal(observed.instrumentedHash, sha256Utf8(observed.code));
  assert.notEqual(observed.instrumentedHash, observed.baselineInstrumentedHash);
  assert.deepEqual(observed.code.match(/@group\([^]*?@binding\(/g), sceneShader.match(/@group\([^]*?@binding\(/g));
  const body = observed.code.match(/fn deepGeometryRoughness\([^]*?\n\}/)![0];
  assert.equal([...body.matchAll(/dpdx\(/g)].length, 1); assert.equal([...body.matchAll(/dpdy\(/g)].length, 1);
  assert(!body.includes("Fine") && !body.includes("Coarse"));
  if (mode === "brdf-dots") assert(observed.code.includes("let nh = clamp(dot(n, h), 0.0, 1.0); let vh = clamp(dot(v, h), 0.0, 1.0);\n  deepC8F32Inputs = vec4f(nv, nl, nh, vh);"));
  if (mode === "dx" || mode === "dy") assert(body.includes("let derivative = max(deepC8InputDx, deepC8InputDy);"));
  assert.equal(observed.coverage, "original-color-only; witness.w is data");
});
test("rejects unknown modes and source drift without accepting a superficially similar shade", () => {
  assert.throws(() => observeDeepF32Inputs("unknown" as "normal"), /Unknown/);
  assert.throws(() => observeDeepF32Inputs("normal", sceneShader + "\n"), /drifted/);
});
test("actual nested wrapper preserves device identity, hashes final submitted module and retains validation", async () => {
  Object.assign(globalThis, { GPUTextureUsage: { COPY_SRC: 1, RENDER_ATTACHMENT: 16 }, GPUBufferUsage: { COPY_DST: 8, MAP_READ: 1 }, GPUMapMode: { READ: 1 } });
  const events: string[] = [], moduleDescriptors: GPUShaderModuleDescriptor[] = [], pipelineDescriptors: GPURenderPipelineDescriptor[] = [];
  const device = {
    limits: { maxBufferSize: 2 ** 24, maxColorAttachmentBytesPerSample: 32 }, lost: new Promise(() => {}), destroy() {},
    createShaderModule(input: GPUShaderModuleDescriptor) { moduleDescriptors.push(input); return {}; },
    createTexture(input: GPUTextureDescriptor) { const size = input.size as number[]; return { width: size[0], height: size[1], format: input.format, usage: input.usage,
      dimension: "2d", depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1, createView: () => ({}), destroy() { events.push("texture-destroy"); } }; },
    createBuffer(input: GPUBufferDescriptor) { const bytes = new ArrayBuffer(input.size); new DataView(bytes).setFloat32(0, -.12345679104328156, true);
      return { mapState: "unmapped", mapAsync: async () => { events.push("map"); }, getMappedRange: () => bytes, unmap() {}, destroy() { events.push("buffer-destroy"); } }; },
    createRenderPipeline(input: GPURenderPipelineDescriptor) { pipelineDescriptors.push(input); return {}; },
    async createRenderPipelineAsync(input: GPURenderPipelineDescriptor) { pipelineDescriptors.push(input); return {}; },
    createCommandEncoder() { return { beginRenderPass: () => ({ setPipeline() {}, drawIndexed() {}, drawIndexedIndirect() {}, end() { events.push("end"); } }),
      copyTextureToBuffer() { events.push("copy"); }, finish() { events.push("finish"); return {}; } }; }, queue: { submit() { events.push("submit"); } },
  } as unknown as GPUDevice;
  const original = device.createShaderModule, adapter = { requestDevice: async () => device } as unknown as GPUAdapter;
  const observer = prepareF32InputObservation("brdf-dots", { requestAdapter: async () => adapter } as unknown as GPU);
  assert.equal(await (await observer.gpu.requestAdapter())!.requestDevice(), device);
  const module = device.createShaderModule({ label: "Deep PBR", code: sceneShader });
  assert.equal(moduleDescriptors[0]!.code, observeDeepF32Inputs("brdf-dots").code);
  assert.throws(() => device.createShaderModule({ label: "Deep PBR", code: sceneShader + "\n" }), /drifted/);
  const pipeline = await device.createRenderPipelineAsync({ label: "Deep forward PBR plain/depth/ccw", layout: "auto", vertex: { module, entryPoint: "vertexMain" },
    fragment: { module, entryPoint: "fragmentMainColor", targets: [{ format: "rgba16float" }] }, primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" }, multisample: { count: 1 } });
  assert.deepEqual(Array.from(pipelineDescriptors[0]!.fragment!.targets), [{ format: "rgba16float" }, { format: "rgba32float" }]);
  const hdr = device.createTexture({ size: [320, 192], format: "rgba16float", usage: 16 }), depth = device.createTexture({ size: [320, 192], format: "depth32float", usage: 16 });
  function frame() {
    const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ label: "Deep HDR opaque color", colorAttachments: [{ view: hdr.createView(), loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 } });
    pass.setPipeline(pipeline); pass.drawIndexed(3); pass.end(); device.queue.submit([encoder.finish()]);
  }
  frame(); observer.armFrame("direct-diagnostic/oblique/exposure-0.5"); frame();
  const snapshots = await observer.snapshots(), receipt = observer.receipt();
  assert.equal(snapshots.length, 2); assert.equal(receipt.mode, "brdf-dots"); assert.equal(receipt.qualityCertified, false);
  assert.equal(receipt.instrumentedHash, sha256Utf8(moduleDescriptors[0]!.code)); assert.equal(receipt.replacedModules, 1);
  assert.deepEqual(receipt.passes, [{ frameId: "c8-f32-1", phase: "validation" }, { frameId: "c8-f32-2", phase: "observed", name: "direct-diagnostic/oblique/exposure-0.5" }]);
  assert.deepEqual(events.slice(0, 5), ["end", "copy", "finish", "submit", "map"]);
  observer.dispose(); observer.dispose(); assert.equal(device.createShaderModule, original);
});
