/**
 * T03 SSR 序列实机采集的页内内核（由 playwright evaluate 序列化注入，必须自包含）。
 * 复刻生产 ScreenSpaceReflectionPass 的绑定与 dispatch 序列（radiance mips → trace → composite），
 * 参数块由 Node 侧用生产 packParameters 打包传入。返回 base64 读回缓冲与 GPU 墙钟成本。
 */
export async function t03SsrPageKernel(payload) {
  const decodeBase64 = (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const encodeBase64 = (buffer) => {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const queueErrors = [];
  device.addEventListener("uncapturederror", (event) => queueErrors.push(String(event?.error?.message ?? event)));
  const module = (label, code) => {
    const shader = device.createShaderModule({ label, code });
    return shader;
  };
  const traceShader = module("t03 trace", payload.wgslTrace);
  const compositeShader = module("t03 composite", payload.wgslComposite);
  const radianceShader = module("t03 radiance", payload.wgslRadiance);
  const messages = [];
  for (const shader of [traceShader, compositeShader, radianceShader]) {
    const info = await shader.getCompilationInfo();
    for (const item of info.messages) messages.push(`${item.type}: ${item.message}`);
  }
  if (messages.length) throw new Error(messages.join("\n"));
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const storage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
  const createTextureSafe = (descriptor) => {
    try { return device.createTexture(descriptor); }
    catch (error) { throw new Error(`createTexture failed: ${JSON.stringify(descriptor)} :: ${error}`); }
  };
  const depth = createTextureSafe({ size: [payload.width, payload.height], format: "r32float", usage });
  const normal = createTextureSafe({ size: [payload.width, payload.height], format: "rgba8unorm", usage });
  const color = createTextureSafe({ size: [payload.width, payload.height], format: "rgba16float", usage });
  device.queue.writeTexture({ texture: depth }, decodeBase64(payload.depthB64),
    { bytesPerRow: payload.width * 4 }, [payload.width, payload.height]);
  device.queue.writeTexture({ texture: normal }, decodeBase64(payload.normalB64),
    { bytesPerRow: payload.width * 4 }, [payload.width, payload.height]);
  device.queue.writeTexture({ texture: color }, decodeBase64(payload.colorB64),
    { bytesPerRow: payload.width * 8 }, [payload.width, payload.height]);
  const radiance = createTextureSafe({ size: [payload.width, payload.height], format: "rgba16float",
    mipLevelCount: payload.radianceMipLevelCount, usage: storage | GPUTextureUsage.COPY_SRC });
  const trace = createTextureSafe({ size: [payload.traceWidth, payload.traceHeight], format: "rgba16float",
    usage: storage | GPUTextureUsage.COPY_SRC });
  const output = createTextureSafe({ size: [payload.width, payload.height], format: "rgba16float",
    usage: storage | GPUTextureUsage.COPY_SRC });
  const radianceLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } }] });
  const traceLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 64 } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } }] });
  const compositeLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 64 } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } }] });
  const pipelineLayout = (layouts) => device.createPipelineLayout({ bindGroupLayouts: layouts });
  const tracePipeline = device.createComputePipeline({ layout: pipelineLayout([traceLayout]),
    compute: { module: traceShader, entryPoint: "traceReflection" } });
  const compositePipeline = device.createComputePipeline({ layout: pipelineLayout([compositeLayout]),
    compute: { module: compositeShader, entryPoint: "compositeReflection" } });
  const radiancePipeline = device.createComputePipeline({ layout: pipelineLayout([radianceLayout]),
    compute: { module: radianceShader, entryPoint: "downsampleRadiance" } });
  const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(params, 0, decodeBase64(payload.paramsB64));
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const view = (texture, baseMipLevel = 0, mipLevelCount = 1) =>
    texture.createView({ baseMipLevel, mipLevelCount });
  const radianceBindings = [];
  for (let level = 0; level < payload.radianceMipLevelCount; level++) {
    radianceBindings.push(device.createBindGroup({ layout: radianceLayout, entries: [
      { binding: 0, resource: level === 0 ? view(color) : view(radiance, level - 1) },
      { binding: 1, resource: view(radiance, level) }] }));
  }
  const traceBinding = device.createBindGroup({ layout: traceLayout, entries: [
    { binding: 0, resource: view(depth) }, { binding: 1, resource: view(normal) },
    { binding: 2, resource: view(radiance, 0, payload.radianceMipLevelCount) },
    { binding: 3, resource: { buffer: params } }, { binding: 4, resource: sampler },
    { binding: 5, resource: view(trace) }] });
  const compositeBinding = device.createBindGroup({ layout: compositeLayout, entries: [
    { binding: 0, resource: view(color) }, { binding: 1, resource: view(trace) },
    { binding: 2, resource: { buffer: params } }, { binding: 3, resource: sampler },
    { binding: 4, resource: view(output) }] });
  const encodeFrame = () => {
    const encoder = device.createCommandEncoder();
    for (let level = 0; level < payload.radianceMipLevelCount; level++) {
      const width = Math.max(1, payload.width >> level), height = Math.max(1, payload.height >> level);
      const pass = encoder.beginComputePass({ label: `radiance ${level}` });
      pass.setPipeline(radiancePipeline); pass.setBindGroup(0, radianceBindings[level]);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    }
    const pass = encoder.beginComputePass({ label: "trace" });
    pass.setPipeline(tracePipeline); pass.setBindGroup(0, traceBinding);
    pass.dispatchWorkgroups(Math.ceil(payload.traceWidth / 8), Math.ceil(payload.traceHeight / 8)); pass.end();
    const composite = encoder.beginComputePass({ label: "composite" });
    composite.setPipeline(compositePipeline); composite.setBindGroup(0, compositeBinding);
    composite.dispatchWorkgroups(Math.ceil(payload.width / 8), Math.ceil(payload.height / 8)); composite.end();
    return encoder.finish();
  };
  const durations = [];
  for (let sample = 0; sample < payload.warmup + payload.samples; sample++) {
    const started = performance.now();
    device.queue.submit([encodeFrame()]);
    await device.queue.onSubmittedWorkDone();
    if (sample >= payload.warmup) durations.push(performance.now() - started);
  }
  const readTrace = device.createBuffer({ size: payload.traceWidth * 8 * payload.traceHeight,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const readOutput = device.createBuffer({ size: payload.width * 8 * payload.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const readRadiance = device.createBuffer({ size: payload.traceWidth * 8 * payload.traceHeight,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: trace }, { buffer: readTrace, bytesPerRow: payload.traceWidth * 8 },
    [payload.traceWidth, payload.traceHeight]);
  encoder.copyTextureToBuffer({ texture: output }, { buffer: readOutput, bytesPerRow: payload.width * 8 },
    [payload.width, payload.height]);
  encoder.copyTextureToBuffer({ texture: radiance, mipLevel: 1 },
    { buffer: readRadiance, bytesPerRow: payload.traceWidth * 8 }, [payload.traceWidth, payload.traceHeight]);
  device.queue.submit([encoder.finish()]);
  await readTrace.mapAsync(GPUMapMode.READ);
  await readOutput.mapAsync(GPUMapMode.READ);
  await readRadiance.mapAsync(GPUMapMode.READ);
  const traceBytes = readTrace.getMappedRange().slice(0);
  const outputBytes = readOutput.getMappedRange().slice(0);
  const radianceBytes = readRadiance.getMappedRange().slice(0);
  readTrace.unmap(); readOutput.unmap(); readRadiance.unmap();
  const info = adapter.info ?? {};
  return { traceB64: encodeBase64(traceBytes), outputB64: encodeBase64(outputBytes),
    radianceMip1B64: encodeBase64(radianceBytes), durations, queueErrors,
    adapter: { vendor: info.vendor ?? "", architecture: info.architecture ?? "",
      device: info.device ?? "", description: info.description ?? "" }, messages };
}
