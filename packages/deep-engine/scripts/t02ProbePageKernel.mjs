/**
 * T02 探针联测页内内核（playwright evaluate 序列化注入，必须自包含；模式沿用
 * t03SsrPageKernel/t08MaterialPageKernel）。驱动生产的 probeRadianceKernel WGSL：
 * 场景 buffers 用 Node 侧 packTlasScene 打包传入，方向表由 CPU 权威方向集打包。
 * 两个导出：`t02ProbeFieldKernel`（全场 fib8/16/32 字段 + 陈旧/目标场 + 逐帧预算收敛）
 * 与 `t02ProbeSamplingKernel`（生产 deepGiSample WGSL 库对墙内接收点采样）。
 * 布局合同：捕获纹理 7×2×5 rgba16float（layer=z，texel=cell.xy），readback 行距 256B。
 */
export async function t02ProbeFieldKernel(payload) {
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
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice({ label: "t02-probe-reference-gpu" });
  const queueErrors = [];
  device.addEventListener("uncapturederror", (event) => queueErrors.push(String(event?.error?.message ?? event)));
  const messages = [];
  const makeModule = (label, code) => {
    const shader = device.createShaderModule({ label, code });
    return shader;
  };
  const radiance = makeModule("t02 production radiance", payload.wgslRadiance);
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
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipeline = device.createComputePipeline({ layout: pipelineLayout,
    compute: { module: radiance, entryPoint: "probe_scene_radiance_batch" } });
  const storage = (label, bytes) => {
    const buffer = device.createBuffer({ label, size: bytes.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, bytes);
    return buffer;
  };
  const sceneBuffers = [
    storage("t02 nodes", decodeBase64(payload.sceneB64.nodes)),
    storage("t02 tlas instances", decodeBase64(payload.sceneB64.instances)),
    storage("t02 vertices", decodeBase64(payload.sceneB64.vertices)),
    storage("t02 indices", decodeBase64(payload.sceneB64.indices)),
    storage("t02 triangle order", decodeBase64(payload.sceneB64.order)),
    storage("t02 instance albedos", decodeBase64(payload.sceneB64.albedos)),
  ];
  const uniform = device.createBuffer({ label: "t02 radiance params",
    size: payload.uniformCapacityBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const overflow = device.createBuffer({ label: "t02 overflow sentinel", size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const probeParams = device.createBuffer({ label: "t02 probe params",
    size: payload.probeParamCount * payload.probeParamBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const capture = device.createTexture({ label: "t02 probe capture",
    size: { width: payload.capture.width, height: payload.capture.height,
      depthOrArrayLayers: payload.capture.layers }, dimension: "2d", mipLevelCount: 1,
    format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
  const captureView = capture.createView({ dimension: "2d-array", baseMipLevel: 0,
    mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: payload.capture.layers });
  const readback = device.createBuffer({ label: "t02 capture readback",
    size: payload.capture.bufferBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const overflowReadback = device.createBuffer({ label: "t02 overflow readback", size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const bindGroup = (pipeline) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
    entries: [
      // 0..5 = nodes/instances/vertices/indices/order/albedos，6 = probeParams（生产布局合同）。
      ...sceneBuffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      { binding: 6, resource: { buffer: probeParams } },
      { binding: 7, resource: { buffer: uniform } },
      { binding: 8, resource: captureView },
      { binding: 9, resource: { buffer: overflow } },
    ] });
  const binding = bindGroup(pipeline);
  const captureCopy = (encoder) => encoder.copyTextureToBuffer({ texture: capture }, {
    buffer: readback, bytesPerRow: payload.capture.bytesPerRow,
    rowsPerImage: payload.capture.rowsPerImage },
    { width: payload.capture.width, height: payload.capture.height,
      depthOrArrayLayers: payload.capture.layers });
  const readCapture = async () => {
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange().slice(0);
    readback.unmap();
    return bytes;
  };
  // 全场运行：uniform(updateCount=全量) + 全量探针参数 → dispatch → 读回。
  const runFullField = async (pipelineKey, uniformB64, paramsB64, workgroups) => {
    device.queue.writeBuffer(uniform, 0, decodeBase64(uniformB64));
    device.queue.writeBuffer(probeParams, 0, decodeBase64(paramsB64));
    device.queue.writeBuffer(overflow, 0, new Uint32Array(1));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: `t02 full field ${pipelineKey}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    captureCopy(encoder);
    encoder.copyBufferToBuffer(overflow, 0, overflowReadback, 0, 4);
    device.queue.submit([encoder.finish()]);
    const bytes = await readCapture();
    await overflowReadback.mapAsync(GPUMapMode.READ);
    const sentinel = new Uint32Array(overflowReadback.getMappedRange().slice(0))[0];
    overflowReadback.unmap();
    return { halfB64: encodeBase64(bytes), overflowSentinel: sentinel };
  };
  const fields = {};
  for (const count of payload.directionCounts) {
    fields[count] = await runFullField(count, payload.uniforms[`full${count}`],
      payload.probeParamsFull, payload.workgroupsFull);
  }
  // Stale and target fields use production 32 directions; compare a fixed 8-probe/frame budget.
  const staleField = await runFullField(32, payload.uniforms.stale32, payload.probeParamsFull,
    payload.workgroupsFull);
  const targetField = await runFullField(32, payload.uniforms.target32, payload.probeParamsFull,
    payload.workgroupsFull);
  // 逐帧预算收敛：每个预算档都从「变化前」的陈旧场出发（重放陈旧场），逐帧覆盖
  // budget 个探针为目标值并读回全场。
  const convergence = [];
  let lastBudget = null;
  for (const frame of payload.frames) {
    if (frame.budget !== lastBudget) {
      await runFullField(32, payload.uniforms.stale32, payload.probeParamsFull, payload.workgroupsFull);
      lastBudget = frame.budget;
    }
    const started = performance.now();
    device.queue.writeBuffer(uniform, 0, decodeBase64(frame.uniformB64));
    device.queue.writeBuffer(probeParams, 0, decodeBase64(frame.paramsB64));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: "t02 budget frame" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(1);
    pass.end();
    captureCopy(encoder);
    device.queue.submit([encoder.finish()]);
    const bytes = await readCapture();
    convergence.push({ halfB64: encodeBase64(bytes),
      wallMs: performance.now() - started, updated: frame.batch.length, budget: frame.budget });
  }
  // 纯 dispatch 成本：固定批量（最大预算档），无读回，encode+submit+完成等待。
  const dispatchDurations = [];
  for (let sample = 0; sample < payload.timing.warmup + payload.timing.samples; sample++) {
    const started = performance.now();
    device.queue.writeBuffer(uniform, 0, decodeBase64(payload.timing.uniformB64));
    device.queue.writeBuffer(probeParams, 0, decodeBase64(payload.timing.paramsB64));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: "t02 dispatch cost" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    if (sample >= payload.timing.warmup) dispatchDurations.push(performance.now() - started);
  }
  const info = adapter.info ?? {};
  return { fields, staleField, targetField, convergence, dispatchDurations,
    queueErrors, messages,
    adapter: { vendor: info.vendor ?? "", architecture: info.architecture ?? "",
      device: info.device ?? "", description: info.description ?? "" } };
}

/**
 * 生产 deepGiSample WGSL 库（probeClipmapSamplingWgsl，含 validity 拒绝 + Chebyshev +
 * 法线权重）对接收点列表采样；records/levels 绑定 group 3（生产 ABI 常量），驱动绑定 group 0。
 */
export async function t02ProbeSamplingKernel(payload) {
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
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice({ label: "t02-probe-sampling-gpu" });
  const queueErrors = [];
  device.addEventListener("uncapturederror", (event) => queueErrors.push(String(event?.error?.message ?? event)));
  const shader = device.createShaderModule({ label: "t02 deepGi sampling", code: payload.wgslSampling });
  const messages = [];
  const info = await shader.getCompilationInfo();
  for (const item of info.messages) messages.push(`${item.type}: ${item.lineNum}: ${item.message}`);
  if (messages.length) throw new Error(messages.join("\n"));
  const driverLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
  ] });
  const emptyLayout = device.createBindGroupLayout({ entries: [] });
  const samplingLayout = device.createBindGroupLayout({ entries: [
    { binding: payload.probeStorageBinding, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" } },
    { binding: payload.levelMetadataBinding, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" } },
  ] });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [driverLayout, emptyLayout, emptyLayout, samplingLayout] }),
    compute: { module: shader, entryPoint: "t02_sample_receivers" } });
  const levels = device.createBuffer({ label: "t02 level metadata",
    size: decodeBase64(payload.levelsB64).byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(levels, 0, decodeBase64(payload.levelsB64));
  const receiversBytes = decodeBase64(payload.receiversB64);
  const outputs = [];
  for (const recordsB64 of payload.recordSetsB64) {
    const records = device.createBuffer({ label: "t02 probe records",
      size: decodeBase64(recordsB64).byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(records, 0, decodeBase64(recordsB64));
    const receivers = device.createBuffer({ label: "t02 receivers",
      size: receiversBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(receivers, 0, receiversBytes);
    const output = device.createBuffer({ label: "t02 sampled outputs",
      size: payload.receiverCount * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ label: "t02 sampled readback",
      size: payload.receiverCount * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const driverGroup = device.createBindGroup({ layout: driverLayout, entries: [
      { binding: 0, resource: { buffer: receivers } }, { binding: 1, resource: { buffer: output } }] });
    const samplingGroup = device.createBindGroup({ layout: samplingLayout, entries: [
      { binding: payload.probeStorageBinding, resource: { buffer: records } },
      { binding: payload.levelMetadataBinding, resource: { buffer: levels } }] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: "t02 sampling" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, driverGroup);
    pass.setBindGroup(3, samplingGroup);
    pass.dispatchWorkgroups(Math.ceil(payload.receiverCount / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, payload.receiverCount * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    outputs.push(encodeBase64(readback.getMappedRange().slice(0)));
    readback.unmap();
    records.destroy(); receivers.destroy(); output.destroy(); readback.destroy();
  }
  levels.destroy();
  return { outputs, queueErrors, messages };
}
