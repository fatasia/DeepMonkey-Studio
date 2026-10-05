import { getActiveLeg } from "./virtualShadowProbeSession.js";

// B1 Brief-VSM probe 诊断安装与资源转储职责(sourceSizeGate 拆分:自 virtualShadowGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:probeAdapterInfo、管线/布局创建追踪(installPipelineTracing)、uncapturederror
// 镜像(installErrorCapture/drainCapturedErrors)、设备请求复刻(probeDeviceRequest)、
// atlas 层读回(dumpShadowAtlasLayer)、驻留页表快照(dumpVirtualShadowResidency)、
// GPU 页表读回(dumpShadowPageTable)。腿状态经 getActiveLeg() 共享,不复制。

/** 诊断:包一层管线/布局创建,失败时把失败管线 label 带进错误消息(定位 Invalid PipelineLayout)。 */
export function installPipelineTracing(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = GPUDevice.prototype as unknown as Record<string, any>;
  const w = window as unknown as { __vsmErrors?: string[] };
  const scopeTrace = (device: GPUDevice, label: string, run: () => unknown): unknown => {
    w.__vsmErrors!.push(`enter ${label}`);
    device.pushErrorScope("validation");
    const value = run();
    void device.popErrorScope().then(error => {
      w.__vsmErrors!.push(error ? `${label}: ${error.message}` : `ok ${label}`);
    }).catch(error => w.__vsmErrors!.push(`${label} pop-failed: ${String(error)}`));
    return value;
  };
  const origBindGroupLayout = proto.createBindGroupLayout as
    ((this: GPUDevice, descriptor: GPUBindGroupLayoutDescriptor) => GPUBindGroupLayout) | undefined;
  if (origBindGroupLayout) {
    proto.createBindGroupLayout = function (this: GPUDevice, descriptor: GPUBindGroupLayoutDescriptor) {
      return scopeTrace(this, `createBindGroupLayout[${descriptor.label ?? "unlabeled"}]`,
        () => origBindGroupLayout.call(this, descriptor));
    };
  }
  const origPipelineLayout = proto.createPipelineLayout as
    ((this: GPUDevice, descriptor: GPUPipelineLayoutDescriptor) => GPUPipelineLayout) | undefined;
  if (origPipelineLayout) {
    proto.createPipelineLayout = function (this: GPUDevice, descriptor: GPUPipelineLayoutDescriptor) {
      return scopeTrace(this, `createPipelineLayout[${descriptor.label ?? "unlabeled"}]`,
        () => origPipelineLayout.call(this, descriptor));
    };
  }
  const origRenderPipeline = proto.createRenderPipeline as
    ((this: GPUDevice, descriptor: GPURenderPipelineDescriptor) => GPURenderPipeline) | undefined;
  if (origRenderPipeline) {
    proto.createRenderPipeline = function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor) {
      try { return origRenderPipeline.call(this, descriptor); }
      catch (error) { throw new Error(`createRenderPipeline[${descriptor.label ?? "unlabeled"}]: ${String(error)}`); }
    };
  }
  const origRenderPipelineAsync = proto.createRenderPipelineAsync as
    ((this: GPUDevice, descriptor: GPURenderPipelineDescriptor) => Promise<GPURenderPipeline>) | undefined;
  if (origRenderPipelineAsync) {
    proto.createRenderPipelineAsync = function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor) {
      return origRenderPipelineAsync.call(this, descriptor).catch(error => {
        throw new Error(`createRenderPipelineAsync[${descriptor.label ?? "unlabeled"}]: ${String(error)}`);
      });
    };
  }
}

/** 诊断:包装 uncapturederror 监听注册,把 Dawn 完整校验消息镜像到 window.__vsmErrors。 */
export function installErrorCapture(): void {
  const w = window as unknown as { __vsmErrors?: string[] };
  w.__vsmErrors = [];
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions): void {
    if (type === "uncapturederror") {
      const wrapped = (event: Event): void => {
        w.__vsmErrors!.push((event as ErrorEvent).message ?? String(event));
        if (typeof listener === "function") listener.call(this, event);
        else listener?.handleEvent.call(listener, event);
      };
      return original.call(this, type, wrapped as EventListener, options);
    }
    return original.call(this, type, listener, options);
  };
}

export function drainCapturedErrors(): readonly string[] {
  const w = window as unknown as { __vsmErrors?: string[] };
  return w.__vsmErrors ?? [];
}

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture };
}

/** 诊断:复刻 DeviceSession 的 requiredLimits/requiredFeatures 组合,返回 requestDevice 结果
 *  与 adapter 上限(定位时间戳特性降级)。 */
export async function probeDeviceRequest(): Promise<unknown> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { error: "no adapter" };
  const limits = adapter.limits;
  const desired = { maxStorageBuffersPerShaderStage: Math.min(10, limits.maxStorageBuffersPerShaderStage),
    maxSampledTexturesPerShaderStage: Math.min(17, limits.maxSampledTexturesPerShaderStage) };
  const features = (["timestamp-query", "texture-compression-bc", "texture-compression-etc2",
    "texture-compression-astc"] as const).filter(feature => adapter.features.has(feature));
  try {
    const device = await adapter.requestDevice({ requiredLimits: desired,
      requiredFeatures: features as GPUFeatureName[] });
    const result = { ok: true, desired, adapterLimits: {
      storage: limits.maxStorageBuffersPerShaderStage, sampled: limits.maxSampledTexturesPerShaderStage },
      deviceFeatures: [...device.features] };
    device.destroy();
    return result;
  } catch (error) {
    return { ok: false, error: String(error), desired, adapterLimits: {
      storage: limits.maxStorageBuffersPerShaderStage, sampled: limits.maxSampledTexturesPerShaderStage } };
  }
}

/** 诊断:读回虚拟阴影 atlas 指定层(2048² r32float)。 */
export async function dumpShadowAtlasLayer(layer = 0): Promise<{ readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly floats: Float32Array; readonly canvasPng: string }> {
  const active = getActiveLeg();
  if (!active) throw new Error("beginLeg was not called.");
  const atlas = (active.renderer as unknown as {
    virtualShadows?: { atlas: GPUTexture };
  }).virtualShadows?.atlas;
  if (!atlas) throw new Error("virtual shadow atlas unavailable (cascaded leg or virtual not constructed).");
  const device = active.renderer.session.device;
  const width = 2048, height = 2048, bytesPerRow = width * 4;
  const buffer = device.createBuffer({ size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: "vsm atlas readback" });
  encoder.copyTextureToBuffer({ texture: atlas, origin: { x: 0, y: 0, z: layer } },
    { buffer, bytesPerRow, rowsPerImage: height }, [width, height, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const floats = new Float32Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  // 灰度可视化贴到离屏 canvas(近=暗),dataURL 随返回值出页(证据存档)。
  const view = 1024, step = width / view;
  const canvas = new OffscreenCanvas(view, view);
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(view, view);
  for (let y = 0; y < view; y++) for (let x = 0; x < view; x++) {
    const value = floats[Math.floor(y * step) * width + Math.floor(x * step)] ?? 1;
    const gray = Math.round((1 - Math.max(0, Math.min(1, value))) * 255);
    const offset = (y * view + x) * 4;
    image.data[offset] = gray; image.data[offset + 1] = gray; image.data[offset + 2] = gray;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!);
  return { width, height, bytesPerRow, floats, canvasPng: `data:image/png;base64,${btoa(binary)}` };
}

/** 诊断:虚拟阴影驻留页表快照(id/slot 对照,定位页内容与页坐标的映射问题)。 */
export function dumpVirtualShadowResidency(): unknown {
  const table = (getActiveLeg()?.renderer as unknown as {
    virtualShadows?: { table: { residentSnapshot(): unknown[] } };
  }).virtualShadows?.table;
  if (!table) throw new Error("virtual shadow table unavailable.");
  return table.residentSnapshot();
}

/** 诊断:读回 GPU 页表(meta+layers)与 CPU 驻留对照(定位采样 miss 的上传/打包问题)。 */
export async function dumpShadowPageTable(): Promise<{ readonly meta: readonly number[];
  readonly layers: readonly number[]; readonly metaWords: number; readonly layerEntries: number;
  readonly uniformTail: readonly number[]; readonly matrices00: readonly number[] }> {
  const active = getActiveLeg();
  const resources = (active?.renderer as unknown as {
    virtualShadows?: { metaBuffer: GPUBuffer; layersBuffer: GPUBuffer; uniformBuffer: GPUBuffer };
  }).virtualShadows;
  if (!resources) throw new Error("virtual shadow resources unavailable.");
  const device = active!.renderer.session.device;
  const readback = async (buffer: GPUBuffer, size: number): Promise<ArrayBuffer> => {
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder({ label: "vsm page table readback" });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  };
  const meta = new Uint32Array(await readback(resources.metaBuffer, resources.metaBuffer.size));
  const layers = new Int32Array(await readback(resources.layersBuffer, resources.layersBuffer.size));
  const uniform = new Float32Array(await readback(resources.uniformBuffer, resources.uniformBuffer.size));
  return { meta: Array.from(meta), layers: Array.from(layers),
    metaWords: resources.metaBuffer.size, layerEntries: resources.layersBuffer.size / 4,
    uniformTail: Array.from(uniform.slice(144, 160)), matrices00: Array.from(uniform.slice(0, 4)) };
}
