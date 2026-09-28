/* T02 真实渲染消费端：用生产 deepGiSampleTexture WGSL + 生产捕获 rgba16float
 * 逐接收点读回。此通路无 distance/variance 通道，不能声称其拥有 Chebyshev。 */
export async function t02ProbeTextureSamplingKernel(payload) {
  const fromB64 = (text) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const toB64 = (array) => {
    const bytes = new Uint8Array(array), parts = [];
    for (let i = 0; i < bytes.length; i += 0x8000) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    }
    return btoa(parts.join(""));
  };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice({ label: "t02-production-texture-consumer" });
  const errors = [];
  device.addEventListener("uncapturederror", event => errors.push(String(event.error?.message ?? event)));
  try {
    const shader = device.createShaderModule({ label: "production probe texture sampler", code: payload.wgsl });
    const messages = (await shader.getCompilationInfo()).messages
      .filter(item => item.type !== "info").map(item => `${item.type}: ${item.message}`);
    if (messages.length) throw new Error(messages.join("\n"));
    const shaderStage = GPUShaderStage.COMPUTE;
    const ioLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: shaderStage, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: shaderStage, buffer: { type: "storage" } },
    ] });
    const empty = device.createBindGroupLayout({ entries: [] });
    const textureLayout = device.createBindGroupLayout({ entries: [
      { binding: 9, visibility: shaderStage, texture: { viewDimension: "2d-array" } },
      { binding: 10, visibility: shaderStage, sampler: { type: "filtering" } },
      { binding: 11, visibility: shaderStage, buffer: { type: "uniform" } },
    ] });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [ioLayout, empty, empty, textureLayout] }),
      compute: { module: shader, entryPoint: "t02_sample_texture_receivers" },
    });
    const buffer = (label, bytes, usage) => {
      const result = device.createBuffer({ label, size: bytes.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(result, 0, bytes);
      return result;
    };
    const receiverData = fromB64(payload.receiversB64);
    const receivers = buffer("receivers", receiverData, GPUBufferUsage.STORAGE);
    const levels = buffer("production texture levels", fromB64(payload.levelsB64), GPUBufferUsage.UNIFORM);
    const output = device.createBuffer({ size: payload.receiverCount * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const ioGroup = device.createBindGroup({ layout: ioLayout, entries: [
      { binding: 0, resource: { buffer: receivers } }, { binding: 1, resource: { buffer: output } },
    ] });
    const texture = device.createTexture({ size: [7, 2, 5], format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const textureView = texture.createView({ dimension: "2d-array" });
    const samplingGroup = device.createBindGroup({ layout: textureLayout, entries: [
      { binding: 9, resource: textureView },
      { binding: 10, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) },
      { binding: 11, resource: { buffer: levels } },
    ] });
    const values = [];
    for (const textureB64 of payload.textureSetsB64) {
      device.queue.writeTexture({ texture }, fromB64(textureB64),
        { bytesPerRow: 256, rowsPerImage: 2 }, [7, 2, 5]);
      const readback = device.createBuffer({ size: payload.receiverCount * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, ioGroup); pass.setBindGroup(3, samplingGroup);
      pass.dispatchWorkgroups(Math.ceil(payload.receiverCount / 64)); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, payload.receiverCount * 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      values.push(toB64(readback.getMappedRange().slice(0)));
      readback.unmap(); readback.destroy();
    }
    return { values, errors, messages, adapter: adapter.info ?? {} };
  } finally { device.destroy(); }
}

/** Production filter stage, exercised before the real texture sampler (no CPU alpha edits). */
export async function t02FilterProductionCapture(payload) {
  const fromB64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
  const toB64 = buffer => {
    const bytes = new Uint8Array(buffer), pieces = [];
    for (let index = 0; index < bytes.length; index += 0x8000) {
      pieces.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
    }
    return btoa(pieces.join(""));
  };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice({ label: "t02-production-probe-filter" });
  const errors = [];
  device.addEventListener("uncapturederror", event => errors.push(String(event.error?.message ?? event)));
  try {
    const shader = device.createShaderModule({ code: payload.filterWgsl });
    const messages = (await shader.getCompilationInfo()).messages
      .filter(item => item.type !== "info").map(item => `${item.type}: ${item.message}`);
    if (messages.length) throw new Error(messages.join("\n"));
    const input = device.createTexture({ size: [7, 2, 5], format: "rgba16float",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    const output = device.createTexture({ size: [7, 2, 5], format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    device.queue.writeTexture({ texture: input }, fromB64(payload.captureB64),
      { bytesPerRow: 256, rowsPerImage: 2 }, [7, 2, 5]);
    const updates = new Uint32Array(70 * 4);
    for (let index = 0; index < 70; index++) {
      updates.set([0, index % 7, Math.floor(index / 7) % 2, Math.floor(index / 14)], index * 4);
    }
    const updateBuffer = device.createBuffer({ size: updates.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(updateBuffer, 0, updates);
    const uniformData = new ArrayBuffer(48);
    new Uint32Array(uniformData).set([70, 5, 1]);
    const uniform = device.createBuffer({ size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, uniformData);
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: "2d-array" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d-array" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: "2d-array" } },
    ] });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: shader, entryPoint: "filterIrradiance" },
    });
    const bindGroup = device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: updateBuffer } },
      { binding: 1, resource: { buffer: uniform } },
      { binding: 3, resource: input.createView({ dimension: "2d-array" }) },
      { binding: 4, resource: output.createView({ dimension: "2d-array" }) },
      { binding: 7, resource: input.createView({ dimension: "2d-array" }) },
    ] });
    const readback = device.createBuffer({ size: 256 * 2 * 5,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(2); pass.end();
    encoder.copyTextureToBuffer({ texture: output }, { buffer: readback,
      bytesPerRow: 256, rowsPerImage: 2 }, { width: 7, height: 2, depthOrArrayLayers: 5 });
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    return { halfB64: toB64(readback.getMappedRange().slice(0)), messages, errors };
  } finally { device.destroy(); }
}
