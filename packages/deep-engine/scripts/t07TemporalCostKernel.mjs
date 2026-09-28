/**
 * T07 成本探针页内内核(独立 evaluate 注入,自包含):测量 TAA resolve 链在
 * 全尺寸与内部尺寸下的归一帧时戳。单 submit 重复 REPEAT 次 mini-frame,
 * 使 GPU 实际工作时长压过 submit 往返固定开销(实测约 3ms)。
 * WGSL 由 payload 传入(生产 TAA / motion / upsample)。
 */
export async function t07TemporalCostKernel(payload) {
  const REPEAT = 32;
  const decodeBase64 = (text) => {
    const binary = atob(text), bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  let adapter;
  for (let attempt = 0; attempt < 3 && !adapter; attempt++) {
    adapter = await navigator.gpu.requestAdapter();
    if (!adapter) await new Promise(resolve => setTimeout(resolve, 400));
  }
  if (!adapter) throw new Error("WebGPU adapter unavailable after retries");
  const device = await adapter.requestDevice();
  const queueErrors = [];
  device.addEventListener("uncapturederror", (event) => queueErrors.push(String(event?.error?.message ?? event)));
  const TEXTURE = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const STORAGE = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
  const makeTexture = (format, width, height, usage, label) => device.createTexture({ label, size: [width, height], format, usage });

  const taaLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 48 } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float" } },
    { binding: 8, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } }] });
  const motionLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } }] });
  const upLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }] });
  const motionPipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [motionLayout] }),
    compute: { module: device.createShaderModule({ label: "t07 cost motion", code: payload.wgslMotion }), entryPoint: "computeMotion" } });
  const taaPipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [taaLayout] }),
    compute: { module: device.createShaderModule({ label: "t07 cost taa", code: payload.wgslTaa }), entryPoint: "resolveTemporal" } });
  const upPipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [upLayout] }),
    compute: { module: device.createShaderModule({ label: "t07 cost upsample", code: payload.wgslUpsample }), entryPoint: "upsampleBilinear" } });
  const zeroMask = makeTexture("r8unorm", 1, 1, TEXTURE, "t07 cost zero mask");
  device.queue.writeTexture({ texture: zeroMask }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
  const makeChain = (width, height, label, pipeline) => {
    const colors = [0, 1].map(index => makeTexture("rgba16float", width, height, STORAGE, `${label} color ${index}`));
    const depths = [0, 1].map(index => makeTexture("r32float", width, height, STORAGE, `${label} depth ${index}`));
    const params = [0, 1].map(index => device.createBuffer({ label: `${label} params ${index}`, size: 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    let historyIndex = 0;
    return {
      colors, depths, maskView: zeroMask.createView(),
      encode(encoder, sourceColor, sourceDepth, motion, historyValid, jitterCur, jitterPrev, options) {
        const write = historyValid ? 1 - historyIndex : 0, read = historyValid ? historyIndex : 1;
        const paramBuffer = new ArrayBuffer(48), floats = new Float32Array(paramBuffer), uints = new Uint32Array(paramBuffer);
        uints.set([width, height, historyValid ? 1 : 0, 0]);
        floats.set([...jitterCur, ...jitterPrev], 4);
        floats.set([options.feedback, options.depthThreshold, options.relativeDepthThreshold, 0], 8);
        device.queue.writeBuffer(params[write], 0, paramBuffer);
        const bindGroup = device.createBindGroup({ layout: taaLayout, entries: [
          { binding: 0, resource: sourceColor.createView() }, { binding: 1, resource: sourceDepth.createView() },
          { binding: 2, resource: motion.createView() }, { binding: 3, resource: colors[read].createView() },
          { binding: 4, resource: depths[read].createView() }, { binding: 5, resource: { buffer: params[write] } },
          { binding: 6, resource: colors[write].createView() }, { binding: 7, resource: depths[write].createView() },
          { binding: 8, resource: this.maskView }] });
        const pass = encoder.beginComputePass({ label: `${label} resolve` });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
        historyIndex = write;
        return colors[write];
      },
      dispose() { for (const texture of [...colors, ...depths]) texture.destroy(); for (const buffer of params) buffer.destroy(); },
    };
  };

  const sourceColor = makeTexture("rgba16float", payload.width, payload.height, TEXTURE, "t07 cost color");
  const sourceDepth = makeTexture("r32float", payload.width, payload.height, TEXTURE, "t07 cost depth");
  const sourceWorld = makeTexture("rgba32float", payload.width, payload.height, TEXTURE, "t07 cost world");
  device.queue.writeTexture({ texture: sourceColor }, decodeBase64(payload.colorB64), { bytesPerRow: payload.width * 8 }, [payload.width, payload.height]);
  device.queue.writeTexture({ texture: sourceDepth }, decodeBase64(payload.depthB64), { bytesPerRow: payload.width * 4 }, [payload.width, payload.height]);
  device.queue.writeTexture({ texture: sourceWorld }, decodeBase64(payload.worldB64), { bytesPerRow: payload.width * 16 }, [payload.width, payload.height]);
  const motion = makeTexture("rgba16float", payload.width, payload.height, STORAGE, "t07 cost motion");
  const rowsBytes = decodeBase64(payload.rowsB64), matricesBytes = decodeBase64(payload.matricesB64);
  const rows = device.createBuffer({ size: rowsBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const matrices = device.createBuffer({ size: matricesBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(rows, 0, rowsBytes); device.queue.writeBuffer(matrices, 0, matricesBytes);
  const motionBind = device.createBindGroup({ layout: motionLayout, entries: [
    { binding: 0, resource: sourceWorld.createView() }, { binding: 1, resource: { buffer: rows } },
    { binding: 2, resource: { buffer: matrices } }, { binding: 3, resource: motion.createView() }] });
  const internalColor = makeTexture("rgba16float", payload.internalWidth, payload.internalHeight, TEXTURE, "t07 cost internal color");
  const internalDepth = makeTexture("r32float", payload.internalWidth, payload.internalHeight, TEXTURE, "t07 cost internal depth");
  device.queue.writeTexture({ texture: internalColor }, decodeBase64(payload.internalColorB64), { bytesPerRow: payload.internalWidth * 8 }, [payload.internalWidth, payload.internalHeight]);
  device.queue.writeTexture({ texture: internalDepth }, decodeBase64(payload.internalDepthB64), { bytesPerRow: payload.internalWidth * 4 }, [payload.internalWidth, payload.internalHeight]);
  const chain = makeChain(payload.width, payload.height, "t07 cost", taaPipeline);
  const upTarget = makeTexture("rgba16float", payload.width, payload.height, STORAGE, "t07 cost up");
  const upParams = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(upParams, 0, new Float32Array([payload.internalWidth, payload.internalHeight, payload.width, payload.height, 0, 0, 0, 0]));
  function upsampleInto(encoder, sourceTexture) {
    const bind = device.createBindGroup({ layout: upLayout, entries: [
      { binding: 0, resource: sourceTexture.createView() }, { binding: 1, resource: upTarget.createView() },
      { binding: 2, resource: { buffer: upParams } }] });
    const pass = encoder.beginComputePass({ label: "t07 cost upsample" });
    pass.setPipeline(upPipeline); pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(payload.width / 8), Math.ceil(payload.height / 8)); pass.end();
  }
  const encodeFrame = (internal) => {
    const encoder = device.createCommandEncoder();
    for (let repeat = 0; repeat < REPEAT; repeat++) {
      const motionPass = encoder.beginComputePass({ label: "t07 cost motion" });
      motionPass.setPipeline(motionPipeline); motionPass.setBindGroup(0, motionBind);
      motionPass.dispatchWorkgroups(Math.ceil(payload.width / 8), Math.ceil(payload.height / 8)); motionPass.end();
      const written = internal ? chain.encode(encoder, internalColor, internalDepth, motion, true, payload.jitterCur, payload.jitterPrev, payload.options)
        : chain.encode(encoder, sourceColor, sourceDepth, motion, true, payload.jitterCur, payload.jitterPrev, payload.options);
      if (internal) upsampleInto(encoder, written);
    }
    return encoder.finish();
  };
  const run = async (internal, warmup, samples) => {
    const durations = [];
    for (let index = 0; index < warmup + samples; index++) {
      const started = performance.now();
      device.queue.submit([encodeFrame(internal)]);
      await device.queue.onSubmittedWorkDone();
      if (index >= warmup) durations.push(performance.now() - started);
    }
    return durations;
  };
  const normalize = (values) => values.map(value => value / REPEAT);
  const fullCostPerFrameMs = normalize(await run(false, 4, 20));
  const internalCostPerFrameMs = normalize(await run(true, 4, 20));
  // 纯 resolve(不含 motion 与上采样):分离分辨率缩放与固定启动开销。
  const encodeResolveOnly = (internalSource) => {
    const encoder = device.createCommandEncoder();
    for (let repeat = 0; repeat < REPEAT; repeat++) {
      chain.encode(encoder, internalSource ? internalColor : sourceColor, internalSource ? internalDepth : sourceDepth,
        motion, true, payload.jitterCur, payload.jitterPrev, payload.options);
    }
    return encoder.finish();
  };
  const runResolveOnly = async (internalSource, warmup, samples) => {
    const durations = [];
    for (let index = 0; index < warmup + samples; index++) {
      const started = performance.now();
      device.queue.submit([encodeResolveOnly(internalSource)]);
      await device.queue.onSubmittedWorkDone();
      if (index >= warmup) durations.push(performance.now() - started);
    }
    return durations;
  };
  const resolveFullPerFrameMs = normalize(await runResolveOnly(false, 4, 20));
  const resolveInternalPerFrameMs = normalize(await runResolveOnly(true, 4, 20));
  chain.dispose();
  const adapterInfo = adapter.info ?? {};
  return { queueErrors, adapter: { vendor: adapterInfo.vendor ?? "", architecture: adapterInfo.architecture ?? "" },
    fullCostPerFrameMs, internalCostPerFrameMs, resolveFullPerFrameMs, resolveInternalPerFrameMs };
}
