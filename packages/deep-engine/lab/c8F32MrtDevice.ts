/// <reference types="@webgpu/types" />
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { encodeFrameCaptureTextureReadback, type FrameCaptureTextureReadback, type FrameCaptureTextureSnapshot } from "../src/webgpu/frameCaptureReadback.js";
import { f32WitnessPipeline, observeDeepF32Mrt, type F32WitnessMode } from "./c8F32MrtShader.js";

export function decodeF32Witness(snapshot: FrameCaptureTextureSnapshot) {
  if (snapshot.format !== "rgba32float" || snapshot.bytesPerRow !== snapshot.width * 16 || snapshot.bytes.length !== snapshot.width * snapshot.height * 16) throw Error("F32 witness snapshot format/stride/length drifted");
  const view = new DataView(snapshot.bytes.buffer, snapshot.bytes.byteOffset, snapshot.bytes.byteLength);
  return Array.from({ length: snapshot.width * snapshot.height * 4 }, (_, i) => view.getFloat32(i * 4, true));
}

/** Native GPU objects retain their identity; only the independent diagnostic descriptors change. */
export function prepareF32MrtObservation(mode: F32WitnessMode, gpu: GPU) {
  const shader = observeDeepF32Mrt(mode), restores: (() => void)[] = [], tickets: FrameCaptureTextureReadback[] = [];
  const textures = new Set<GPUTexture>(), reads: Promise<FrameCaptureTextureSnapshot>[] = [];
  const modules = new WeakSet<GPUShaderModule>(), pipelines = new WeakSet<GPURenderPipeline>();
  const passes: { frameId: string; phase: "validation" | "observed"; name?: string }[] = [], armedNames = new Set<string>();
  let armed: string | undefined;
  let disposed = false, moduleCount = 0, pipelineCount = 0, passCount = 0, drawCount = 0, submitted = 0;
  function live() { if (disposed) throw Error("F32 witness observer disposed"); }
  function patch(target: object, key: string, value: unknown) {
    const own = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    restores.push(() => { if (own) Object.defineProperty(target, key, own); else Reflect.deleteProperty(target, key); });
  }
  function instrument(device: GPUDevice) {
    if (disposed) { device.destroy(); live(); }
    if (device.limits.maxColorAttachmentBytesPerSample < 24) { device.destroy(); throw Error("F32 witness requires 24 attachment bytes per sample"); }
    const views = new WeakMap<GPUTextureView, { texture: GPUTexture; descriptor: GPUTextureViewDescriptor }>();
    const pending = new WeakMap<GPUCommandBuffer, { ticket: FrameCaptureTextureReadback; texture: GPUTexture }>();
    const createTexture = device.createTexture.bind(device), createModule = device.createShaderModule.bind(device);
    const createPipeline = device.createRenderPipeline.bind(device), createPipelineAsync = device.createRenderPipelineAsync.bind(device);
    const createEncoder = device.createCommandEncoder.bind(device), submit = device.queue.submit.bind(device.queue);
    patch(device, "createTexture", (descriptor: GPUTextureDescriptor) => {
      live(); const texture = createTexture(descriptor), createView = texture.createView.bind(texture);
      patch(texture, "createView", (input: GPUTextureViewDescriptor = {}) => { const view = createView(input); views.set(view, { texture, descriptor: input }); return view; });
      return texture;
    });
    patch(device, "createShaderModule", (descriptor: GPUShaderModuleDescriptor) => {
      live(); if (descriptor.label !== "Deep PBR") return createModule(descriptor);
      if (sha256Utf8(descriptor.code) !== shader.originalHash) throw Error("F32 witness production module drifted");
      const module = createModule({ ...descriptor, code: shader.code }); modules.add(module); moduleCount++; return module;
    });
    const transform = (descriptor: GPURenderPipelineDescriptor) => descriptor.label === "Deep forward PBR plain/depth/ccw" ? f32WitnessPipeline(descriptor, modules) : descriptor;
    function record(descriptor: GPURenderPipelineDescriptor, pipeline: GPURenderPipeline) {
      if (descriptor.fragment?.entryPoint === "deepC8F32FragmentMainColor") { pipelines.add(pipeline); pipelineCount++; } return pipeline;
    }
    patch(device, "createRenderPipeline", (descriptor: GPURenderPipelineDescriptor) => { live(); const next = transform(descriptor); return record(next, createPipeline(next)); });
    patch(device, "createRenderPipelineAsync", async (descriptor: GPURenderPipelineDescriptor) => { live(); const next = transform(descriptor); const pipeline = await createPipelineAsync(next); live(); return record(next, pipeline); });
    patch(device, "createCommandEncoder", (input?: GPUCommandEncoderDescriptor) => {
      live(); const encoder = createEncoder(input), begin = encoder.beginRenderPass.bind(encoder), finish = encoder.finish.bind(encoder);
      let witness: GPUTexture | undefined, ended = false, localDraws = 0, frameId: string | undefined;
      patch(encoder, "beginRenderPass", (descriptor: GPURenderPassDescriptor) => {
        if (descriptor.label !== "Deep HDR opaque color") return begin(descriptor);
        live(); const attachments = Array.from(descriptor.colorAttachments), color = attachments[0], metadata = color && views.get(color.view as GPUTextureView);
        const texture = metadata?.texture, view = metadata?.descriptor, depth = descriptor.depthStencilAttachment;
        const depthMetadata = depth && views.get(depth.view as GPUTextureView), depthTexture = depthMetadata?.texture;
        if (witness || attachments.length !== 1 || !color || color.resolveTarget || color.depthSlice !== undefined || color.loadOp !== "clear" || color.storeOp !== "store"
          || !texture || texture.format !== "rgba16float" || texture.width !== 320 || texture.height !== 192 || texture.sampleCount !== 1
          || texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || view?.format && view.format !== "rgba16float"
          || (view?.dimension ?? "2d") !== "2d" || (view?.mipLevelCount ?? 1) !== 1 || (view?.arrayLayerCount ?? 1) !== 1
          || (view?.baseMipLevel ?? 0) !== 0 || (view?.baseArrayLayer ?? 0) !== 0
          || !depth || depth.depthLoadOp !== "clear" || depth.depthStoreOp !== "store" || depth.depthReadOnly || depth.depthClearValue !== 1
          || !depthTexture || depthTexture.format !== "depth32float" || depthTexture.sampleCount !== 1 || depthTexture.width !== 320 || depthTexture.height !== 192
          || (depthMetadata?.descriptor.baseMipLevel ?? 0) !== 0 || (depthMetadata?.descriptor.baseArrayLayer ?? 0) !== 0
          || depthMetadata?.descriptor.format && depthMetadata.descriptor.format !== "depth32float") throw Error("F32 witness requires canonical 320x192 single-color HDR pass");
        witness = createTexture({ label: `C8 F32 ${mode}`, size: [320, 192], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        textures.add(witness); passCount++; frameId = `c8-f32-${passCount}`;
        passes.push({ frameId, phase: armed ? "observed" : "validation", ...(armed ? { name: armed } : {}) }); armed = undefined;
        const pass = begin({ ...descriptor, colorAttachments: [...attachments, { view: witness.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }] });
        const setPipeline = pass.setPipeline.bind(pass), end = pass.end.bind(pass), draw = pass.drawIndexed.bind(pass), indirect = pass.drawIndexedIndirect.bind(pass);
        let bound = false;
        patch(pass, "setPipeline", (pipeline: GPURenderPipeline) => { if (!pipelines.has(pipeline)) throw Error("F32 witness draw used a noncanonical pipeline"); bound = true; setPipeline(pipeline); });
        function drew() { if (!bound || ended) throw Error("F32 witness draw without live canonical pipeline"); drawCount++; localDraws++; }
        patch(pass, "drawIndexed", (...args: Parameters<GPURenderPassEncoder["drawIndexed"]>) => { drew(); draw(...args); });
        patch(pass, "drawIndexedIndirect", (...args: Parameters<GPURenderPassEncoder["drawIndexedIndirect"]>) => { drew(); indirect(...args); });
        for (const unsupported of ["draw", "drawIndirect", "executeBundles"]) patch(pass, unsupported, () => { throw Error("F32 witness requires observed indexed canonical draws"); });
        patch(pass, "end", () => { if (ended) throw Error("F32 witness pass ended twice"); end(); ended = true; });
        return pass;
      });
      patch(encoder, "finish", (descriptor?: GPUCommandBufferDescriptor) => {
        live(); let ticket: FrameCaptureTextureReadback | undefined;
        if (witness) {
          if (!ended || localDraws < 1) throw Error("F32 witness pass missing completed draw");
          ticket = encodeFrameCaptureTextureReadback(device, encoder, { frameId: frameId!, resourceId: `c8-${mode}-f32`, source: witness, width: 320, height: 192 }, { timeoutMs: 60000 }); tickets.push(ticket);
        }
        const buffer = finish(descriptor); if (ticket && witness) pending.set(buffer, { ticket, texture: witness }); return buffer;
      });
      return encoder;
    });
    patch(device.queue, "submit", (buffers: Iterable<GPUCommandBuffer>) => {
      live(); const list = Array.from(buffers); submit(list);
      for (const buffer of list) { const capture = pending.get(buffer); if (!capture) continue; pending.delete(buffer); submitted++;
        const read = capture.ticket.readAfterSubmit().finally(() => { capture.texture.destroy(); textures.delete(capture.texture); });
        void read.catch(() => {}); reads.push(read);
      }
    });
    return device;
  }
  const isolatedGpu = new Proxy(gpu, { get(target, property) {
    if (property === "requestAdapter") return async (options?: GPURequestAdapterOptions) => {
      live(); const adapter = await target.requestAdapter(options); live();
      return adapter && new Proxy(adapter, { get(adapterTarget, key) {
        if (key === "requestDevice") return async (descriptor?: GPUDeviceDescriptor) => instrument(await adapterTarget.requestDevice(descriptor));
        const value = Reflect.get(adapterTarget, key, adapterTarget); return typeof value === "function" ? value.bind(adapterTarget) : value;
      } });
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { gpu: isolatedGpu,
    /** Called in the existing Three compile hook immediately before the corresponding explicit backend.render. */
    armFrame(name: string) {
      live(); if (armed || armedNames.has(name) || !/^(strict-emissive|direct-diagnostic)\/(front|oblique)\/exposure-0\.5$/.test(name)) throw Error("F32 witness duplicate, pending or invalid frame arm");
      armed = name; armedNames.add(name);
    },
    async snapshots() { live(); const snapshots = await Promise.all(reads); if (passCount < 1 || submitted !== passCount || snapshots.length !== passCount) throw Error("F32 witness missing actual submitted pass snapshots"); return snapshots; },
    receipt() { if (moduleCount < 1 || pipelineCount < 1 || drawCount < 1 || passCount < 1 || submitted !== passCount || armed) throw Error("F32 witness actual receipt incomplete");
      return { mode, qualityCertified: false, originalHash: shader.originalHash, instrumentedHash: shader.instrumentedHash, moduleCount, pipelineCount, passCount, drawCount, submitted,
        originalColorFormat: "rgba16float", witnessFormat: "rgba32float", attachmentBytesPerSample: 24, sampleCount: 1, canonicalPipeline: "plain/depth/ccw", passes: passes.map(pass => ({ ...pass })), armedFrameCount: armedNames.size }; },
    dispose() { if (disposed) return; disposed = true; for (const ticket of tickets) ticket.cancel(); for (const texture of textures) texture.destroy(); textures.clear(); for (const restore of restores.reverse()) restore(); },
  };
}
