/**
 * F5 失效收敛联测页内内核（playwright evaluate 序列化注入，自包含；布局合同与
 * t02ProbePageKernel 一致：捕获纹理 7×2×5 rgba16float、readback 行距 256B、生产
 * probeRadianceKernel WGSL + 打包器 uniform）。与 t02 内核的差异：多场景可重入——
 * 每个场景自带 stale/target uniform 与**由真实 ProbeClipmapUpdateScheduler 产出的**
 * 逐帧批次序列，逐帧 dispatch + 全场读回，供 Node 侧量化亮度残差衰减曲线。
 */
export async function f5ProbeInvalidationKernel(payload) {
  const decodeBase64 = (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
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
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice({ label: "f5-probe-invalidation-gpu" });
  const queueErrors = [];
  device.addEventListener("uncapturederror", (event) => queueErrors.push(String(event?.error?.message ?? event)));
  const messages = [];
  const radiance = device.createShaderModule({ label: "f5 production radiance", code: payload.wgslRadiance });
  const compilation = await radiance.getCompilationInfo();
  for (const item of compilation.messages) messages.push(`${item.type}: ${item.lineNum}: ${item.message}`);
  if (messages.length) throw new Error(messages.join("\n"));
  const layout = device.createBindGroupLayout({ entries: [
    ...[0, 1, 2, 3, 4, 5, 6].map(binding => ({
      binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } })),
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    { binding: 8, visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d-array" } },
    { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
  ] });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: radiance, entryPoint: "probe_scene_radiance_batch" } });
  const storage = (label, bytes) => {
    const buffer = device.createBuffer({ label, size: bytes.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, bytes);
    return buffer;
  };
  const sceneBuffers = [
    storage("f5 nodes", decodeBase64(payload.sceneB64.nodes)),
    storage("f5 tlas instances", decodeBase64(payload.sceneB64.instances)),
    storage("f5 vertices", decodeBase64(payload.sceneB64.vertices)),
    storage("f5 indices", decodeBase64(payload.sceneB64.indices)),
    storage("f5 triangle order", decodeBase64(payload.sceneB64.order)),
    storage("f5 instance albedos", decodeBase64(payload.sceneB64.albedos)),
  ];
  const uniform = device.createBuffer({ label: "f5 radiance params",
    size: payload.uniformCapacityBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const overflow = device.createBuffer({ label: "f5 overflow sentinel",
    size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const probeParams = device.createBuffer({ label: "f5 probe params",
    size: payload.probeParamCount * payload.probeParamBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const capture = device.createTexture({ label: "f5 probe capture",
    size: { width: payload.capture.width, height: payload.capture.height,
      depthOrArrayLayers: payload.capture.layers }, dimension: "2d", mipLevelCount: 1,
    format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
  const captureView = capture.createView({ dimension: "2d-array", baseMipLevel: 0,
    mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: payload.capture.layers });
  const readback = device.createBuffer({ label: "f5 capture readback",
    size: payload.capture.bufferBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const overflowReadback = device.createBuffer({ label: "f5 overflow readback", size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    ...sceneBuffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    { binding: 6, resource: { buffer: probeParams } },
    { binding: 7, resource: { buffer: uniform } },
    { binding: 8, resource: captureView },
    { binding: 9, resource: { buffer: overflow } }] });
  const captureCopy = (encoder) => encoder.copyTextureToBuffer({ texture: capture }, {
    buffer: readback, bytesPerRow: payload.capture.bytesPerRow,
    rowsPerImage: payload.capture.rowsPerImage },
    { width: payload.capture.width, height: payload.capture.height,
      depthOrArrayLayers: payload.capture.layers });
  const readCapture = async () => {
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange().slice(0);
    readback.unmap();
    return encodeBase64(bytes);
  };
  const runFullField = async (uniformB64) => {
    device.queue.writeBuffer(uniform, 0, decodeBase64(uniformB64));
    device.queue.writeBuffer(probeParams, 0, decodeBase64(payload.probeParamsFullB64));
    device.queue.writeBuffer(overflow, 0, new Uint32Array(1));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: "f5 full field" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(payload.workgroupsFull);
    pass.end();
    captureCopy(encoder);
    encoder.copyBufferToBuffer(overflow, 0, overflowReadback, 0, 4);
    device.queue.submit([encoder.finish()]);
    const halfB64 = await readCapture();
    await overflowReadback.mapAsync(GPUMapMode.READ);
    const sentinel = new Uint32Array(overflowReadback.getMappedRange().slice(0))[0];
    overflowReadback.unmap();
    return { halfB64, overflowSentinel: sentinel };
  };
  const scenarios = {};
  const dispatchDurations = [];
  for (const scenario of payload.scenarios) {
    const staleField = await runFullField(scenario.staleUniformB64);
    const targetField = await runFullField(scenario.targetUniformB64);
    // 重放陈旧场：frames 的起点必须是「变化前」的场（与 t02 收敛重放同语义），
    // 否则上一行 target 捕获已把场带到新稳态、逐帧残差恒 0。
    await runFullField(scenario.staleUniformB64);
    const frames = [];
    for (const frame of scenario.frames) {
      const started = performance.now();
      device.queue.writeBuffer(uniform, 0, decodeBase64(frame.uniformB64));
      device.queue.writeBuffer(probeParams, 0, decodeBase64(frame.paramsB64));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass({ label: "f5 invalidation frame" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      captureCopy(encoder);
      device.queue.submit([encoder.finish()]);
      const halfB64 = await readCapture();
      frames.push({ halfB64, wallMs: performance.now() - started,
        updated: frame.updated, level: frame.level });
    }
    scenarios[scenario.name] = { staleField, targetField, frames };
  }
  // 纯 dispatch 成本（固定批 8，无读回）。
  for (let sample = 0; sample < payload.timing.warmup + payload.timing.samples; sample++) {
    const started = performance.now();
    device.queue.writeBuffer(uniform, 0, decodeBase64(payload.timing.uniformB64));
    device.queue.writeBuffer(probeParams, 0, decodeBase64(payload.timing.paramsB64));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: "f5 dispatch cost" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    if (sample >= payload.timing.warmup) dispatchDurations.push(performance.now() - started);
  }
  const info = adapter.info ?? {};
  return { scenarios, dispatchDurations, queueErrors, messages,
    adapter: { vendor: info.vendor ?? "", architecture: info.architecture ?? "",
      device: info.device ?? "", description: info.description ?? "" } };
}
