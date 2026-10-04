/**
 * AA-M2 接线探针的上采样页内内核(playwright evaluate 序列化注入,必须自包含且为纯 JS,
 * 与 t07TemporalGpuPageKernel.mjs 同纪律 —— .mts 会被 tsx 注入 __name 助手而无法序列化)。
 * 同输入跑 legacy(HEAD)/off(生产默认)/on(开关翻转)三条显示分辨率历史链,输出三链
 * 逐帧 base64,供 Node 侧逐字节对拍。
 */
export function temporalUpscaleWiringKernel(payload) {
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
  return (async () => {
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
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 64 } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } }] });
    const { width, height, internalWidth, internalHeight } = payload;
    const zeroMask = device.createTexture({ label: "probe zero mask", size: [1, 1], format: "r8unorm", usage: TEXTURE });
    device.queue.writeTexture({ texture: zeroMask }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
    // 零运动场(rg16float):静态机位,历史位置 = 原位,时域路径全覆盖(与生产 rg16float 合同同格式)。
    const zeroMotion = device.createTexture({ label: "probe zero motion", size: [internalWidth, internalHeight], format: "rg16float", usage: TEXTURE });
    device.queue.writeTexture({ texture: zeroMotion }, new Uint8Array(internalWidth * internalHeight * 4), { bytesPerRow: internalWidth * 4 }, [internalWidth, internalHeight]);
    const makeChain = async (label, code) => {
      const module = device.createShaderModule({ label, code });
      const messages = [];
      for (const item of await module.getCompilationInfo().then(info => info.messages)) messages.push(`${item.type}: ${item.message}`);
      if (messages.length) throw new Error(`${label}: ${messages.join("\n")}`);
      const pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "upscaleTemporal" } });
      const textures = (format, usage) => [0, 1].map(index =>
        device.createTexture({ label: `${label} ${format} ${index}`, size: [width, height], format, usage }));
      const colors = textures("rgba16float", STORAGE), depths = textures("r32float", STORAGE);
      const params = [0, 1].map(index => device.createBuffer({ label: `${label} params ${index}`, size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      const maskView = zeroMask.createView();
      let historyIndex = 0;
      return {
        async encode(sourceColor, sourceDepth, historyValid) {
          const write = historyValid ? 1 - historyIndex : 0, read = historyValid ? historyIndex : 1;
          const buffer = new ArrayBuffer(64), uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
          uints.set([width, height, internalWidth, internalHeight], 0);
          uints.set([historyValid ? 1 : 0, 0, 0, 0], 4);
          const displayScale = width / internalWidth;
          floats.set([payload.options.feedback, payload.options.depthThreshold, payload.options.relativeDepthThreshold, displayScale], 8);
          floats.set([0, 0, 0, 0], 12);
          device.queue.writeBuffer(params[write], 0, buffer);
          const encoder = device.createCommandEncoder();
          const bindGroup = device.createBindGroup({ layout, entries: [
            { binding: 0, resource: sourceColor.createView() }, { binding: 1, resource: sourceDepth.createView() },
            { binding: 2, resource: zeroMotion.createView() }, { binding: 3, resource: colors[read].createView() },
            { binding: 4, resource: depths[read].createView() }, { binding: 5, resource: { buffer: params[write] } },
            { binding: 6, resource: colors[write].createView() }, { binding: 7, resource: depths[write].createView() },
            { binding: 8, resource: maskView }] });
          const pass = encoder.beginComputePass({ label: `${label} upscale` });
          pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
          const readback = device.createBuffer({ size: aligned(width * 8) * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          encoder.copyTextureToBuffer({ texture: colors[write] }, { buffer: readback, bytesPerRow: aligned(width * 8) }, [width, height]);
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
          historyIndex = write;
          await readback.mapAsync(GPUMapMode.READ);
          const bytes = new Uint8Array(readback.getMappedRange().slice(0));
          readback.destroy();
          return bytes;
        },
        dispose() { for (const texture of [...colors, ...depths]) texture.destroy(); for (const buffer of params) buffer.destroy(); },
      };
    };
    const sourceColor = device.createTexture({ label: "probe source color", size: [internalWidth, internalHeight], format: "rgba16float", usage: TEXTURE });
    const sourceDepth = device.createTexture({ label: "probe source depth", size: [internalWidth, internalHeight], format: "r32float", usage: TEXTURE });
    const result = { queueErrors, rowStride: aligned(width * 8) };
    for (const [name, code] of [["legacy", payload.wgslLegacy], ["off", payload.wgslOff], ["on", payload.wgslOn]]) {
      const chain = await makeChain(`probe ${name}`, code);
      const frames = [];
      for (const frame of payload.frames) {
        device.queue.writeTexture({ texture: sourceColor }, decodeBase64(frame.colorB64), { bytesPerRow: internalWidth * 8 }, [internalWidth, internalHeight]);
        device.queue.writeTexture({ texture: sourceDepth }, decodeBase64(frame.depthB64), { bytesPerRow: internalWidth * 4 }, [internalWidth, internalHeight]);
        frames.push(encodeBase64(await chain.encode(sourceColor, sourceDepth, frame.historyValid)));
      }
      result[`${name}Frames`] = frames;
      chain.dispose();
    }
    return result;
  })();
}
