/// <reference types="@webgpu/types" />
import { surfaceSize, type SurfaceSize } from "./surfaceSize.js";
import { DeviceResourceMemory, validateDeviceMemoryBudget } from "./deviceResourceMemory.js";

export type DeviceState = "ready" | "lost" | "disposed";
export interface DeviceEvent { readonly kind: "lost" | "error"; readonly message: string }
interface Destroyable { destroy(): void }
const OPTIONAL_DEVICE_FEATURES = Object.freeze([
  "timestamp-query", "texture-compression-bc", "texture-compression-etc2", "texture-compression-astc",
] as const satisfies readonly GPUFeatureName[]);

function aborted(): DOMException { return new DOMException("GPU preparation cancelled", "AbortError"); }

/** 请求不可中断的驱动 API 时立即响应取消，并回收迟到的 device。 */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal, release?: (value: T) => void): Promise<T> {
  if (signal.aborted) {
    void promise.then((value) => release?.(value), () => {});
    throw aborted();
  }
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const guarded = promise.then((value) => {
    if (signal.aborted) { release?.(value); throw aborted(); }
    return value;
  });
  try { return await Promise.race([guarded, cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** 每个实例独占 device、canvas context 和资源；没有全局渲染循环或共享 GPU cache。 */
export class DeviceSession {
  private readonly resources = new Set<Destroyable>();
  private readonly memory: DeviceResourceMemory;
  private readonly events: DeviceEvent[] = [];
  private currentState: DeviceState = "ready";
  private size: SurfaceSize | undefined;
  private readonly errorListener = (event: Event): void => {
    event.preventDefault();
    this.events.push({ kind: "error", message: (event as GPUUncapturedErrorEvent).error.message });
  };

  private constructor(
    readonly device: GPUDevice,
    readonly context: GPUCanvasContext,
    readonly format: GPUTextureFormat,
    private readonly canvas: HTMLCanvasElement,
    readonly adapterInfo: Readonly<{ vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean }> | undefined,
    memoryBudgetBytes?: number,
  ) {
    this.memory = new DeviceResourceMemory(memoryBudgetBytes);
    device.addEventListener("uncapturederror", this.errorListener);
    void device.lost.then((info) => {
      if (this.currentState !== "ready") return;
      this.currentState = "lost";
      this.events.push({ kind: "lost", message: info.message || info.reason });
    });
  }

  static async open(canvas: HTMLCanvasElement, gpu: GPU | undefined, signal: AbortSignal, memoryBudgetBytes?: number): Promise<DeviceSession> {
    validateDeviceMemoryBudget(memoryBudgetBytes);
    if (signal.aborted) throw aborted();
    if (!gpu) throw new Error("WebGPU is unavailable in this browser.");
    const adapter = await abortable(gpu.requestAdapter({ powerPreference: "high-performance" }), signal);
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    const requestedFeatures = OPTIONAL_DEVICE_FEATURES.filter(feature => adapter.features.has(feature));
    let device: GPUDevice;
    try {
      device = await abortable(adapter.requestDevice({ label: "Deep Engine isolated device",
        ...(requestedFeatures.length ? { requiredFeatures: requestedFeatures } : {}) }), signal, (value) => value.destroy());
    } catch (error) {
      // 可选计时或压缩能力可降级，不能使可用的核心渲染设备无法启动。
      if (!requestedFeatures.length || signal.aborted) throw error;
      device = await abortable(adapter.requestDevice({ label: "Deep Engine core device" }), signal, (value) => value.destroy());
    }
    let session: DeviceSession | undefined;
    try {
      if (signal.aborted) throw aborted();
      const context = canvas.getContext("webgpu");
      if (!context) throw new Error("Canvas cannot create a WebGPU context.");
      const info = adapter.info;
      session = new DeviceSession(device, context, gpu.getPreferredCanvasFormat(), canvas, info ? Object.freeze({
        vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter,
      }) : undefined, memoryBudgetBytes);
      session.resize(canvas.clientWidth, canvas.clientHeight, 1);
      return session;
    } catch (error) {
      if (session) session.dispose(); else device.destroy();
      throw error;
    }
  }

  get state(): DeviceState { return this.currentState; }
  get diagnostics(): readonly DeviceEvent[] { return this.events.slice(); }
  get hasErrors(): boolean { return this.events.some((event) => event.kind === "error"); }
  get resourceCount(): number { return this.resources.size; }
  get resourceMemory() { return this.memory.snapshot; }
  assertResourceAdmission(descriptor: object): void {
    if (this.currentState !== "ready") throw new Error("GPU session is not ready.");
    this.memory.assertCanAdd(descriptor);
  }

  own<T extends Destroyable>(resource: T): T {
    if (this.currentState !== "ready") { resource.destroy(); throw new Error("GPU session is not ready."); }
    try { this.memory.add(resource); }
    catch (error) { resource.destroy(); throw error; }
    this.resources.add(resource);
    return resource;
  }

  release(resource: Destroyable): void {
    if (this.resources.delete(resource)) { this.memory.remove(resource); resource.destroy(); }
  }

  resize(width: number, height: number, ratio: number): SurfaceSize | undefined {
    if (this.currentState !== "ready") return undefined;
    const size = surfaceSize(width, height, ratio, this.device.limits.maxTextureDimension2D);
    if (!size) return undefined;
    if (this.size?.width !== size.width || this.size.height !== size.height) {
      this.canvas.width = size.width;
      this.canvas.height = size.height;
      this.context.configure({ device: this.device, format: this.format, alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      this.size = size;
    }
    return size;
  }

  dispose(): void {
    if (this.currentState === "disposed") return;
    this.currentState = "disposed";
    this.device.removeEventListener("uncapturederror", this.errorListener);
    try {
      for (const resource of this.resources) {
        try { resource.destroy(); } catch (error) {
          this.events.push({ kind: "error", message: `Resource disposal: ${String(error)}` });
        }
      }
    } finally {
      this.resources.clear();
      this.memory.clear();
      try { this.context.unconfigure(); } finally { this.device.destroy(); }
    }
  }
}
