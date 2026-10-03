/// <reference types="@webgpu/types" />
import { surfaceSize, type SurfaceSize } from "./surfaceSize.js";
import { DeviceResourceMemory, validateDeviceMemoryBudget } from "./deviceResourceMemory.js";
import { probeHdrDisplayCanvas, type HdrDisplayCanvasCapability } from "./hdrDisplayCanvas.js";
import type { HdrDisplayRequest } from "./hdrDisplayOutput.js";
import { classifyDeviceLost, classifyUncapturedError, DeviceRecoveryStateMachine,
  type DeviceRecoveryEvent, type DeviceRecoveryOptions, type DeviceRecoverySnapshot, type GpuErrorClassification } from "./deviceRecovery.js";

/**
 * ready/degraded 下设备可用（degraded = 出现过 validation 等非致命错误，渲染继续）；
 * recovering = 会话内恢复进行中；lost = 恢复耗尽或不可恢复（终态，交给回退链）；
 * disposed = 正常关闭（终态）。既有消费方按 `=== "ready"` / `=== "lost"` 的判断全部保持语义。
 */
export type DeviceState = "ready" | "degraded" | "recovering" | "lost" | "disposed";
export interface DeviceEvent { readonly kind: "lost" | "error"; readonly message: string }
interface Destroyable { destroy(): void }
const OPTIONAL_DEVICE_FEATURES = Object.freeze([
  "timestamp-query", "texture-compression-bc", "texture-compression-etc2", "texture-compression-astc",
] as const satisfies readonly GPUFeatureName[]);

function aborted(): DOMException { return new DOMException("GPU preparation cancelled", "AbortError"); }

/** @webgpu/types 会窄化 HTMLCanvasElement；布局尺寸在运行时来自真实 DOM canvas。 */
type CanvasLayout = { readonly clientWidth: number; readonly clientHeight: number; width: number; height: number };

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
  private currentDevice: GPUDevice;
  private size: SurfaceSize | undefined;
  private readonly recoveryMachine: DeviceRecoveryStateMachine | undefined;
  private readonly lostDevices = new WeakSet<GPUDevice>();
  private readonly recreateListeners = new Set<(epoch: number) => void>();
  private readonly fatalListeners = new Set<(reason: DeviceEvent) => void>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveringNow = false;
  private retiredResourceCount = 0;
  private currentFormat: GPUTextureFormat;
  private extendedCanvas = false;
  private canvasRevision = 0;
  private readonly errorListener = (event: Event): void => {
    event.preventDefault();
    const message = (event as GPUUncapturedErrorEvent).error.message;
    this.events.push({ kind: "error", message });
    this.dispatchClassification(classifyUncapturedError((event as GPUUncapturedErrorEvent).error));
  };

  private constructor(
    readonly context: GPUCanvasContext,
    private readonly preferredFormat: GPUTextureFormat,
    device: GPUDevice,
    private readonly canvas: HTMLCanvasElement,
    private readonly gpu: GPU,
    readonly adapterInfo: Readonly<{ vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean }> | undefined,
    memoryBudgetBytes?: number,
    recovery?: DeviceRecoveryOptions,
    private readonly requiredLimits?: Record<string, number>,
    readonly hdrDisplayCapability?: HdrDisplayCanvasCapability,
  ) {
    this.currentDevice = device;
    this.currentFormat = preferredFormat;
    this.memory = new DeviceResourceMemory(memoryBudgetBytes);
    this.recoveryMachine = recovery === undefined ? undefined : new DeviceRecoveryStateMachine(recovery);
    device.addEventListener("uncapturederror", this.errorListener);
    this.observeDeviceLost(device);
  }

  static async open(canvas: HTMLCanvasElement, gpu: GPU | undefined, signal: AbortSignal, memoryBudgetBytes?: number,
    recovery?: DeviceRecoveryOptions, capabilities?: { readonly layeredMaterials?: boolean;
      readonly hdrDisplay?: HdrDisplayRequest; readonly extendedShadowBindings?: boolean }): Promise<DeviceSession> {
    validateDeviceMemoryBudget(memoryBudgetBytes);
    if (signal.aborted) throw aborted();
    if (!gpu) throw new Error("WebGPU is unavailable in this browser.");
    const adapter = await abortable(gpu.requestAdapter({ powerPreference: "high-performance" }), signal);
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    // B1 Brief-VSM:group 2 增补(页表 storage ×2 + 页 atlas 采样纹理 ×1)后,主片元
    // 布局峰值为 10 storage / 17 sampled;layered 材质峰值 19 sampled。按需取并集、
    // clamp 到 adapter 上限(requestDevice 不接受超上限值),适配器不足时由管线布局
    // 验证显式失败(fail-closed,不静默降级),虚拟档回退级联路径见 PbrShadowState。
    const desiredLimits: Record<string, number> = {};
    if (capabilities?.extendedShadowBindings === true) {
      desiredLimits.maxStorageBuffersPerShaderStage = 10;
      desiredLimits.maxSampledTexturesPerShaderStage = 17;
    }
    if (capabilities?.layeredMaterials === true) {
      desiredLimits.maxSampledTexturesPerShaderStage
        = Math.max(desiredLimits.maxSampledTexturesPerShaderStage ?? 0, 19);
    }
    const requiredLimits = Object.keys(desiredLimits).length === 0 ? undefined
      : Object.fromEntries(Object.entries(desiredLimits).map(([key, value]) => [key,
        Math.min(value, adapter.limits[key as keyof GPUSupportedLimits] as number)]));
    if (requiredLimits && (requiredLimits.maxSampledTexturesPerShaderStage ?? 0) < (desiredLimits.maxSampledTexturesPerShaderStage ?? 0)
      && capabilities?.layeredMaterials === true) {
      throw new Error("PBR capability layered-materials/texture-limit: adapter requires 19 sampled textures.");
    }
    const requestedFeatures = OPTIONAL_DEVICE_FEATURES.filter(feature => adapter.features.has(feature));
    // 逐档降级(特性优先):limits 与 features 任一不被接受都只降那一维 ——
    // 时间戳(诊断计时)/纹理压缩特性不因 per-stage 上限被拒而连带丢失。
    let device: GPUDevice;
    const deviceAttempts: GPUDeviceDescriptor[] = [
      { label: "Deep Engine isolated device",
        ...(requiredLimits ? { requiredLimits } : {}),
        ...(requestedFeatures.length ? { requiredFeatures: requestedFeatures } : {}) },
      ...(requestedFeatures.length ? [{ label: "Deep Engine core device",
        requiredFeatures: requestedFeatures } as GPUDeviceDescriptor] : []),
      { label: "Deep Engine core device" },
    ];
    let lastDeviceError: unknown;
    device = undefined as unknown as GPUDevice;
    for (const descriptor of deviceAttempts) {
      try {
        device = await abortable(adapter.requestDevice(descriptor), signal, (value) => value.destroy());
        break;
      } catch (error) {
        lastDeviceError = error;
        if (signal.aborted) throw error;
      }
    }
    if (device === undefined) throw lastDeviceError ?? aborted();
    let session: DeviceSession | undefined;
    try {
      if (signal.aborted) throw aborted();
      const context = canvas.getContext("webgpu");
      if (!context) throw new Error("Canvas cannot create a WebGPU context.");
      const info = adapter.info;
      const hdr = capabilities?.hdrDisplay === undefined ? undefined
        : await abortable(probeHdrDisplayCanvas(device, canvas, capabilities.hdrDisplay), signal);
      session = new DeviceSession(context, gpu.getPreferredCanvasFormat(), device, canvas, gpu, info ? Object.freeze({
        vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter,
      }) : undefined, memoryBudgetBytes, recovery, requiredLimits, hdr);
      const layout = canvas as unknown as CanvasLayout;
      session.resize(layout.clientWidth, layout.clientHeight, 1);
      return session;
    } catch (error) {
      if (session) session.dispose(); else device.destroy();
      throw error;
    }
  }

  get device(): GPUDevice { return this.currentDevice; }
  get format(): GPUTextureFormat { return this.currentFormat; }
  get hdrCanvasActive(): boolean { return this.extendedCanvas; }
  /** Called only after a valid HDR present pipeline candidate is ready. Failure restores the SDR surface. */
  async activateHdrCanvas(device: GPUDevice, isCurrent: () => boolean): Promise<void> {
    if (this.hdrDisplayCapability?.policy.mode !== "hdr" || device !== this.device || !this.usable() || !isCurrent())
      throw new Error("HDR canvas candidate is not current or supported.");
    const revision = ++this.canvasRevision;
    let scopeOpen = true;
    device.pushErrorScope("validation");
    try {
      this.context.configure({ device, format: "rgba16float", alphaMode: "opaque", toneMapping: { mode: "extended" },
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const actual = this.context.getConfiguration();
      const pending = device.popErrorScope(); scopeOpen = false;
      const error = await pending;
      if (error) throw new Error(error.message);
      if (actual?.format !== "rgba16float" || actual.toneMapping?.mode !== "extended") throw new Error("HDR canvas configuration was not retained.");
      if (revision !== this.canvasRevision || device !== this.device || !this.usable() || !isCurrent()) throw new Error("HDR canvas candidate was superseded.");
      this.currentFormat = "rgba16float"; this.extendedCanvas = true;
    } catch (error) {
      if (scopeOpen) try { await device.popErrorScope(); } catch { /* device loss owns diagnostics */ }
      if (revision === this.canvasRevision && this.usable() && device === this.device) this.restoreSdrCanvas();
      throw error;
    }
  }
  restoreSdrCanvas(): void {
    this.canvasRevision++;
    this.currentFormat = this.preferredFormat; this.extendedCanvas = false;
    if (this.usable()) this.context.configure({ device: this.device, format: this.format, alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  }
  get state(): DeviceState { return this.currentState; }
  get diagnostics(): readonly DeviceEvent[] { return this.events.slice(); }
  get hasErrors(): boolean { return this.events.some((event) => event.kind === "error"); }
  get resourceCount(): number { return this.resources.size; }
  get resourceMemory() { return this.memory.snapshot; }
  /** 恢复状态快照（面板可读）；未启用恢复时为 undefined。 */
  get recovery(): DeviceRecoverySnapshot | undefined { return this.recoveryMachine?.snapshot; }
  /** 恢复审计事件（分型/状态迁移/尝试/成功/终态）；未启用时为空。 */
  get recoveryEvents(): readonly DeviceRecoveryEvent[] { return this.recoveryMachine?.events ?? []; }
  /** 恢复时随失效设备退役的资源累计数（泄漏审计对账用）。 */
  get retiredResources(): number { return this.retiredResourceCount; }
  /** 恢复成功（新设备就绪、surface 已重新 configure）后通知；返回退订函数。 */
  onDeviceRecreated(listener: (epoch: number) => void): () => void {
    this.recreateListeners.add(listener);
    return () => this.recreateListeners.delete(listener);
  }
  /** 恢复耗尽/不可恢复丢失（终态）：单次通知，上层在此交接既有 WebGL 回退链。 */
  onFatalLoss(listener: (reason: DeviceEvent) => void): () => void {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  private usable(): boolean { return this.currentState === "ready" || this.currentState === "degraded"; }

  /** 终态判定走方法而不是字段比较：异步回调间的状态变化不能被 TS 控制流窄化假设。 */
  private isTerminal(): boolean { return this.currentState === "disposed" || this.currentState === "lost"; }
  private isDisposed(): boolean { return this.currentState === "disposed"; }

  private dispatchClassification(classification: GpuErrorClassification): void {
    const machine = this.recoveryMachine;
    if (!machine || this.currentState === "disposed" || this.currentState === "lost" || this.recoveringNow) return;
    const decision = machine.noteClassified(classification);
    if (decision === "recover") this.startRecovery(classification.code, classification.message);
    else if (decision === "degrade") { machine.degrade(); this.currentState = "degraded"; }
  }

  /** lost 事件按设备一次性观察；正常 dispose 先置 disposed 再 destroy，不会误入恢复。 */
  private observeDeviceLost(device: GPUDevice): void {
    void device.lost.then((info) => {
      if (this.lostDevices.has(device)) return;
      this.lostDevices.add(device);
      if (this.currentState === "disposed") return;
      const classification = classifyDeviceLost(info.reason, info.message);
      if (!classification.recoverable && this.recoveryMachine && classification.code === "device-lost/destroyed"
        && !this.isTerminal() && !this.recoveringNow) {
        // 非 dispose 路径的显式销毁：按不可恢复终态处理，交回退链。
        this.fatalLoss("device-lost/destroyed", classification.message);
        return;
      }
      this.dispatchClassification(classification);
      // 未启用恢复（或已终态）时保持既有行为：立即置 lost 并留痕，渲染死掉、上层接管。
      if (!this.recoveryMachine && !this.isTerminal()) {
        this.fatalLoss(classification.code, classification.message);
      }
    });
  }

  /** 会话内恢复：申请新 adapter/device（保守核心配置）并重绑 surface、退役旧资源表。 */
  private startRecovery(code: string, message: string): void {
    const machine = this.recoveryMachine;
    if (!machine || this.currentState === "disposed" || this.currentState === "lost" || this.recoveringNow) return;
    this.recoveringNow = true;
    this.currentState = "recovering";
    try { machine.beginRecovery(); } catch { this.recoveringNow = false; return; }
    void this.attemptRecovery(machine, code, message);
  }

  private async attemptRecovery(machine: DeviceRecoveryStateMachine, code: string, message: string): Promise<void> {
    if (this.isDisposed()) { this.recoveringNow = false; return; }
    let recreated: GPUDevice;
    try {
      // GPUAdapter is consumed by requestDevice on conforming implementations.
      // Each recovery attempt needs a fresh adapter, including failed retries.
      const adapter = await this.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (this.isDisposed()) { this.recoveringNow = false; return; }
      if (!adapter) throw new Error("No WebGPU adapter is available for recovery.");
      recreated = await adapter.requestDevice({ label: "Deep Engine recovered device", ...(this.requiredLimits ? { requiredLimits: this.requiredLimits } : {}) });
      // await 期间会话可能已关闭：迟到的成功必须丢弃（销毁新设备），不得复活会话。
      if (this.isDisposed()) { recreated.destroy(); this.recoveringNow = false; return; }
      if (this.lostDevices.has(recreated)) throw new Error("recovery returned an already-lost device");
      this.adoptRecoveredDevice(recreated);
      machine.recordRecovered();
      this.recoveringNow = false;
      this.currentState = "ready";
      const epoch = machine.snapshot.epoch;
      for (const listener of this.recreateListeners) listener(epoch);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const outcome = machine.recordAttemptFailure("recovery/adapter-unavailable", `${message} (${reason})`);
      if (outcome.action === "retry" && this.currentState === "recovering") {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          if (this.currentState === "recovering") void this.attemptRecovery(machine, code, message);
        }, outcome.backoffMs);
        return;
      }
      this.recoveringNow = false;
      machine.declareFatal("recovery/exhausted", `GPU session recovery failed after ${machine.snapshot.attempts} attempt(s).`);
      this.fatalLoss("recovery/exhausted", machine.snapshot.lastMessage ?? message);
    }
  }

  /** 旧设备已整体失效：句柄随设备回收，这里只做账面退役（不调 destroy），换绑新设备。 */
  private adoptRecoveredDevice(device: GPUDevice): void {
    this.currentDevice.removeEventListener("uncapturederror", this.errorListener);
    this.retiredResourceCount += this.resources.size;
    this.resources.clear();
    this.memory.clear();
    this.currentDevice = device;
    device.addEventListener("uncapturederror", this.errorListener);
    this.observeDeviceLost(device);
    // 旧设备失效后 canvas context 绑定失效，恢复必须重新 configure；尺寸不变仅重绑设备。
    const canvas = this.canvas as unknown as CanvasLayout;
    canvas.width = this.size?.width ?? canvas.width;
    canvas.height = this.size?.height ?? canvas.height;
    this.context.configure({ device, format: this.format, alphaMode: "opaque",
      ...(this.extendedCanvas ? { toneMapping: { mode: "extended" as const } } : {}),
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  }

  private fatalLoss(code: string, message: string): void {
    if (this.currentState === "disposed" || this.currentState === "lost") return;
    this.recoveringNow = false;
    this.currentState = "lost";
    const event: DeviceEvent = { kind: "lost", message };
    this.events.push(event);
    const reason: DeviceEvent = { kind: "lost", message: `${code}: ${message}` };
    for (const listener of this.fatalListeners) listener(reason);
  }

  assertResourceAdmission(descriptor: object): void {
    if (!this.usable()) throw new Error("GPU session is not ready.");
    this.memory.assertCanAdd(descriptor);
  }

  own<T extends Destroyable>(resource: T): T {
    if (!this.usable()) { resource.destroy(); throw new Error("GPU session is not ready."); }
    try { this.memory.add(resource); }
    catch (error) { resource.destroy(); throw error; }
    this.resources.add(resource);
    return resource;
  }

  release(resource: Destroyable): void {
    if (this.resources.delete(resource)) { this.memory.remove(resource); resource.destroy(); }
  }

  resize(width: number, height: number, ratio: number): SurfaceSize | undefined {
    if (!this.usable()) return undefined;
    const size = surfaceSize(width, height, ratio, this.currentDevice.limits.maxTextureDimension2D);
    if (!size) return undefined;
    if (this.size?.width !== size.width || this.size.height !== size.height) {
      const canvas = this.canvas as unknown as CanvasLayout;
      canvas.width = size.width;
      canvas.height = size.height;
      this.context.configure({ device: this.currentDevice, format: this.format, alphaMode: "opaque",
        ...(this.extendedCanvas ? { toneMapping: { mode: "extended" as const } } : {}),
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      this.size = size;
    }
    return size;
  }

  dispose(): void {
    if (this.currentState === "disposed") return;
    this.currentState = "disposed";
    if (this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    this.recoveringNow = false;
    this.recreateListeners.clear();
    this.fatalListeners.clear();
    this.currentDevice.removeEventListener("uncapturederror", this.errorListener);
    try {
      for (const resource of this.resources) {
        try { resource.destroy(); } catch (error) {
          this.events.push({ kind: "error", message: `Resource disposal: ${String(error)}` });
        }
      }
    } finally {
      this.resources.clear();
      this.memory.clear();
      try { this.context.unconfigure(); } finally { this.currentDevice.destroy(); }
    }
  }
}
