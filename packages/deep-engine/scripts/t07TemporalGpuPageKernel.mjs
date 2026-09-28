/**
 * T07 时域序列实机采集的页内内核(playwright evaluate 序列化注入,必须自包含)。
 * 生产 WGSL 从 Node 侧 payload 传入:baseline 与 ghost-guard 共用 TemporalAaPass 的
 * 绑定布局(binding 0-8,含 reactive mask;binding 8 缺省绑 1×1 零回退,与生产
 * TemporalAaPass 一致)。motion/upsample 内核代码由 payload.wgslMotion/wgslUpsample 传入。
 * 成本探针在 t07TemporalCostKernel.mjs(独立 evaluate)。
 * adapter 请求带重试:Chrome 冷启动首次拉起 GPU 进程可能失败。
 */
export async function t07TemporalPageKernel(payload) {
  const decodeBase64 = (text) => {
    const binary = atob(text), bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const encodeBase64 = (buffer) => {
    let binary = "";
    for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode.apply(null, buffer.subarray(index, index + 0x8000));
    return btoa(binary);
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
  const aligned = (bytes) => Math.ceil(bytes / 256) * 256;
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
  const motionShader = device.createShaderModule({ label: "t07 motion", code: payload.wgslMotion });
  const taaModule = device.createShaderModule({ label: "t07 taa", code: payload.wgslTaa });
  const guardModule = payload.wgslGuard ? device.createShaderModule({ label: "t07 guard", code: payload.wgslGuard }) : undefined;
  const upShader = device.createShaderModule({ label: "t07 upsample", code: payload.wgslUpsample });
  const messages = [];
  for (const shader of [motionShader, taaModule, guardModule, upShader]) {
    if (!shader) continue;
    for (const item of (await shader.getCompilationInfo()).messages) messages.push(`${item.type}: ${item.message}`);
  }
  if (messages.length) throw new Error(messages.join("\n"));
  const toPipeline = (module) => device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [taaLayout] }),
    compute: { module, entryPoint: "resolveTemporal" } });
  const taaPipeline = toPipeline(taaModule);
  const guardPipeline = guardModule ? toPipeline(guardModule) : undefined;
  const motionPipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [motionLayout] }),
    compute: { module: motionShader, entryPoint: "computeMotion" } });
  const upPipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [upLayout] }),
    compute: { module: upShader, entryPoint: "upsampleBilinear" } });
  const zeroMask = makeTexture("r8unorm", 1, 1, TEXTURE, "t07 zero mask");
  device.queue.writeTexture({ texture: zeroMask }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);

  /** 一条 TAA 变体的历史链:color/depth 双缓冲 ping-pong,与生产 TemporalAaPass 同构;encode 返回本帧写入的颜色纹理。 */
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

  /** 内部分辨率上采样:4 tap 手工双线性;提交并返回可映射读回缓冲。 */
  const upsample = (sourceTexture, width, height, internalWidth, internalHeight) => {
    const upTarget = makeTexture("rgba16float", width, height, STORAGE, "t07 upsampled");
    const params = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(params, 0, new Float32Array([internalWidth, internalHeight, width, height, 0, 0, 0, 0]));
    const encoder = device.createCommandEncoder();
    const bind = device.createBindGroup({ layout: upLayout, entries: [
      { binding: 0, resource: sourceTexture.createView() }, { binding: 1, resource: upTarget.createView() },
      { binding: 2, resource: { buffer: params } }] });
    const pass = encoder.beginComputePass({ label: "t07 upsample" });
    pass.setPipeline(upPipeline); pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    const buffer = device.createBuffer({ size: aligned(width * 8) * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture: upTarget }, { buffer, bytesPerRow: aligned(width * 8) }, [width, height]);
    device.queue.submit([encoder.finish()]);
    return buffer;
  };

  /** 逐帧执行一条链:motion → resolve;未定时时对每帧输出做读回拷贝。 */
  async function runSequence(width, height, frames, chain, readMotion, timedRepeat) {
    const sourceColor = makeTexture("rgba16float", width, height, TEXTURE, "t07 source color");
    const sourceDepth = makeTexture("r32float", width, height, TEXTURE, "t07 source depth");
    const sourceWorld = makeTexture("rgba32float", width, height, TEXTURE, "t07 source world");
    const rowStride = { color: aligned(width * 8), motion: aligned(width * 8) };
    const reads = [], durations = [];
    let lastWritten;
    const totalFrames = frames.length * (timedRepeat ?? 1);
    for (let step = 0; step < totalFrames; step++) {
      const frameIndex = step % frames.length, frame = frames[frameIndex];
      device.queue.writeTexture({ texture: sourceColor }, decodeBase64(frame.colorB64), { bytesPerRow: width * 8 }, [width, height]);
      device.queue.writeTexture({ texture: sourceDepth }, decodeBase64(frame.depthB64), { bytesPerRow: width * 4 }, [width, height]);
      device.queue.writeTexture({ texture: sourceWorld }, decodeBase64(frame.worldB64), { bytesPerRow: width * 16 }, [width, height]);
      if (!frame.motionTexture) {
        frame.motionTexture = makeTexture("rgba16float", width, height, STORAGE, "t07 motion");
        frame.rowsBytes = decodeBase64(frame.rowsB64);
        frame.matricesBytes = decodeBase64(frame.matricesB64);
        frame.rowsBuffer = device.createBuffer({ size: frame.rowsBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        frame.matricesBuffer = device.createBuffer({ size: frame.matricesBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(frame.rowsBuffer, 0, frame.rowsBytes);
        device.queue.writeBuffer(frame.matricesBuffer, 0, frame.matricesBytes);
      }
      const encoder = device.createCommandEncoder();
      const motionBind = device.createBindGroup({ layout: motionLayout, entries: [
        { binding: 0, resource: sourceWorld.createView() },
        { binding: 1, resource: { buffer: frame.rowsBuffer } },
        { binding: 2, resource: { buffer: frame.matricesBuffer } },
        { binding: 3, resource: frame.motionTexture.createView() }] });
      const motionPass = encoder.beginComputePass({ label: "t07 motion" });
      motionPass.setPipeline(motionPipeline); motionPass.setBindGroup(0, motionBind);
      motionPass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); motionPass.end();
      lastWritten = chain.encode(encoder, sourceColor, sourceDepth, frame.motionTexture,
        frame.historyValid, frame.jitterCur, frame.jitterPrev, payload.options);
      if (timedRepeat === undefined) {
        const taaBuffer = device.createBuffer({ size: rowStride.color * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        encoder.copyTextureToBuffer({ texture: lastWritten }, { buffer: taaBuffer, bytesPerRow: rowStride.color }, [width, height]);
        reads.push({ buffer: taaBuffer, kind: "taa" });
        if (readMotion) {
          const motionBuffer = device.createBuffer({ size: rowStride.motion * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          encoder.copyTextureToBuffer({ texture: frame.motionTexture }, { buffer: motionBuffer, bytesPerRow: rowStride.motion }, [width, height]);
          reads.push({ buffer: motionBuffer, kind: "motion" });
        }
      }
      const started = performance.now();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      if (timedRepeat !== undefined) durations.push(performance.now() - started);
    }
    const taaFrames = [], motionFrames = [];
    for (const { buffer, kind } of reads) {
      await buffer.mapAsync(GPUMapMode.READ);
      (kind === "taa" ? taaFrames : motionFrames).push(new Uint8Array(buffer.getMappedRange().slice(0)));
      buffer.destroy();
    }
    sourceColor.destroy(); sourceDepth.destroy(); sourceWorld.destroy();
    return { taaFrames, motionFrames, durations, rowStride, lastWritten };
  }

  const result = { queueErrors, adapter: (() => { const info = adapter.info ?? {}; return { vendor: info.vendor ?? "", architecture: info.architecture ?? "" }; })() };
  if (payload.mode === "sequence") {
    const baselineChain = makeChain(payload.width, payload.height, "t07 baseline", taaPipeline);
    const guardChain = makeChain(payload.width, payload.height, "t07 guard", guardPipeline);
    const baseline = await runSequence(payload.width, payload.height, payload.frames, baselineChain, true, undefined);
    const guard = await runSequence(payload.width, payload.height, payload.frames, guardChain, false, undefined);
    if (payload.maskB64) {
      const maskChain = makeChain(payload.width, payload.height, "t07 masked", taaPipeline);
      const maskTexture = makeTexture("r8unorm", payload.width, payload.height, TEXTURE, "t07 reactive mask");
      device.queue.writeTexture({ texture: maskTexture }, decodeBase64(payload.maskB64), { bytesPerRow: payload.width }, [payload.width, payload.height]);
      maskChain.maskView = maskTexture.createView();
      const masked = await runSequence(payload.width, payload.height, payload.frames, maskChain, false, undefined);
      result.maskedFrames = masked.taaFrames.map(encodeBase64);
      maskChain.dispose();
    }
    const timed = await runSequence(payload.width, payload.height, payload.frames, baselineChain, false, 40);
    result.baselineFrames = baseline.taaFrames.map(encodeBase64);
    result.motionFrames = baseline.motionFrames.map(encodeBase64);
    result.guardFrames = guard.taaFrames.map(encodeBase64);
    result.timedMs = timed.durations;
    result.rowStride = baseline.rowStride;
    baselineChain.dispose(); guardChain.dispose();
  } else if (payload.mode === "quality") {
    const nativeChain = makeChain(payload.width, payload.height, "t07 native", taaPipeline);
    const internalChain = makeChain(payload.internalWidth, payload.internalHeight, "t07 internal", taaPipeline);
    const native = await runSequence(payload.width, payload.height, payload.frames, nativeChain, false, undefined);
    const internal = await runSequence(payload.internalWidth, payload.internalHeight, payload.internalFrames, internalChain, false, undefined);
    const buffer = upsample(internal.lastWritten, payload.width, payload.height, payload.internalWidth, payload.internalHeight);
    await buffer.mapAsync(GPUMapMode.READ);
    result.nativeFinal = encodeBase64(native.taaFrames.at(-1));
    result.upsampled = encodeBase64(new Uint8Array(buffer.getMappedRange().slice(0)));
    result.rowStride = native.rowStride;
    buffer.destroy(); nativeChain.dispose(); internalChain.dispose();
  }
  return result;
}
