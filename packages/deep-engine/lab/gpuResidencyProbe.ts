/// <reference types="@webgpu/types" />
import {
  GpuResidencyExecutor,
  GpuResidencyExecutorError,
  ResourceResidencyController,
  type GpuResidencyUploader,
  type GpuResidencyUploadRequest,
} from "@bim-studio/deep-engine/streaming";
import { GpuResidencyRuntime, type DeviceSession } from "@bim-studio/deep-engine/webgpu";

interface GpuBufferHandle {
  readonly buffer: GPUBuffer;
  readonly value: number;
  released: boolean;
}

interface UploadGate {
  readonly started: Promise<GpuBufferHandle>;
  signalStarted(handle: GpuBufferHandle): void;
  readonly resume: Promise<void>;
  continue(): void;
}

export interface GpuResidencyProbeResult {
  readonly action: "gpu-residency-transaction";
  readonly success: boolean;
  readonly initialUploadReadback: boolean;
  readonly failedReplacementRetained: boolean;
  readonly atomicReplacementPublished: boolean;
  readonly plannedBytesMatched: boolean;
  readonly cancellationReleased: boolean;
  readonly disposeReleased: boolean;
  readonly deviceLossObserved: boolean;
  readonly staleCandidateReleased: boolean;
  readonly adapterRuntime: boolean;
  readonly initialValue: number | null;
  readonly retainedValue: number | null;
  readonly replacementValue: number | null;
  readonly releasedBuffers: number;
  readonly failure?: string;
}

const EMPTY_RESULT = Object.freeze({
  initialUploadReadback: false,
  failedReplacementRetained: false,
  atomicReplacementPublished: false,
  plannedBytesMatched: false,
  cancellationReleased: false,
  disposeReleased: false,
  deviceLossObserved: false,
  staleCandidateReleased: false,
  adapterRuntime: false,
  initialValue: null,
  retainedValue: null,
  replacementValue: null,
  releasedBuffers: 0,
});

export function evaluateGpuResidencyProbe(result: Omit<GpuResidencyProbeResult, "action" | "success">): boolean {
  return result.initialUploadReadback && result.failedReplacementRetained
    && result.atomicReplacementPublished && result.plannedBytesMatched
    && result.cancellationReleased && result.disposeReleased
    && result.deviceLossObserved && result.staleCandidateReleased && result.adapterRuntime;
}

class RealGpuBufferUploader implements GpuResidencyUploader<GpuBufferHandle> {
  readonly created: GpuBufferHandle[] = [];
  readonly released: GpuBufferHandle[] = [];
  private readonly gates = new Map<string, UploadGate>();
  private readonly sizeDeltas = new Map<string, number>();

  constructor(private readonly device: GPUDevice) {}

  pause(key: string): UploadGate {
    const gate = createGate();
    this.gates.set(key, gate);
    return gate;
  }

  mismatch(key: string, delta: number): void { this.sizeDeltas.set(key, delta); }
  clearMismatch(key: string): void { this.sizeDeltas.delete(key); }

  async upload(request: GpuResidencyUploadRequest) {
    const key = uploadKey(request), size = request.expectedByteLength + (this.sizeDeltas.get(key) ?? 0);
    const value = uploadValue(request);
    const buffer = this.device.createBuffer({
      label: `Deep residency probe ${key}`,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.device.queue.writeBuffer(buffer, 0, new Uint32Array([value]));
    await this.device.queue.onSubmittedWorkDone();
    const handle: GpuBufferHandle = { buffer, value, released: false };
    this.created.push(handle);
    const gate = this.gates.get(key);
    if (gate) { gate.signalStarted(handle); await gate.resume; this.gates.delete(key); }
    return { handle, byteLength: buffer.size };
  }

  release(handle: GpuBufferHandle): void {
    if (handle.released) throw new Error("GPU residency probe observed a double release.");
    handle.released = true;
    handle.buffer.destroy();
    this.released.push(handle);
  }

  destroyRemaining(): void {
    for (const handle of this.created) if (!handle.released) handle.buffer.destroy();
  }
}

/** Runs real GPUBuffer upload, readback, atomic swap and terminal lifecycle checks. */
export async function verifyGpuResidencyTransactions(session: DeviceSession): Promise<GpuResidencyProbeResult> {
  if (session.state !== "ready") throw new Error("GPU residency probe requires a ready device session.");
  const uploader = new RealGpuBufferUploader(session.device);
  let executor: GpuResidencyExecutor<GpuBufferHandle> | undefined;
  try {
    const controller = controllerFor("asset");
    executor = new GpuResidencyExecutor(controller, uploader);
    const initialPlan = controller.planFrame(1, [{ id: "asset", desiredLevel: 1 }]);
    await executor.execute(initialPlan);
    const initial = executor.get("asset")!;
    const initialValue = await readUint(session.device, initial.handle.buffer);
    const initialUploadReadback = initialValue === initial.handle.value && initial.byteLength === 64;

    const upgradeKey = "asset:1:0";
    uploader.mismatch(upgradeKey, 4);
    const failed = await executor.execute(controller.planFrame(2, [{ id: "asset", desiredLevel: 0 }]));
    const retained = executor.get("asset")!;
    const retainedValue = await readUint(session.device, retained.handle.buffer);
    const mismatch = uploader.created.at(-1)!;
    const failedReplacementRetained = failed.commit.failedUploads.includes("asset")
      && failed.uploadFailures.some(({ id, reason }) => id === "asset"
        && reason instanceof GpuResidencyExecutorError && reason.code === "invalid-plan")
      && retained.handle === initial.handle && !initial.handle.released && mismatch.released
      && retainedValue === initialValue;

    uploader.clearMismatch(upgradeKey);
    const replacementPlan = controller.planFrame(3, [{ id: "asset", desiredLevel: 0 }]);
    const gate = uploader.pause(upgradeKey);
    const replacing = executor.execute(replacementPlan);
    const candidate = await gate.started;
    const oldVisibleDuringUpload = executor.get("asset")?.handle === initial.handle && !initial.handle.released;
    gate.continue();
    const replacementResult = await replacing;
    const replacement = executor.get("asset")!;
    const replacementValue = await readUint(session.device, replacement.handle.buffer);
    const atomicReplacementPublished = oldVisibleDuringUpload && replacementResult.commit.appliedUploads.includes("asset")
      && replacement.handle === candidate && initial.handle.released && replacementValue === candidate.value;
    const plannedBytesMatched = initial.handle.buffer.size === initialPlan.uploads[0]!.byteLength
      && replacement.handle.buffer.size === replacementPlan.uploads[0]!.byteLength
      && mismatch.buffer.size !== replacementPlan.uploads[0]!.byteLength;

    const cancellationReleased = await verifyCancellation(session.device);
    const releasedBeforeDispose = replacement.handle.released;
    executor.dispose();
    const disposeReleased = !releasedBeforeDispose && replacement.handle.released && executor.disposed && executor.size === 0;
    const lifecycle = await verifyActualDeviceLoss();
    const adapterRuntime = await verifyGpuBufferResidencyRuntime(session);
    const values = {
      initialUploadReadback, failedReplacementRetained, atomicReplacementPublished, plannedBytesMatched,
      cancellationReleased, disposeReleased, ...lifecycle, adapterRuntime, initialValue, retainedValue, replacementValue,
      releasedBuffers: uploader.released.length,
    };
    return Object.freeze({ action: "gpu-residency-transaction", success: evaluateGpuResidencyProbe(values), ...values });
  } catch (error) {
    try { executor?.dispose(); } catch { /* Preserve the primary probe failure. */ }
    return Object.freeze({ action: "gpu-residency-transaction", success: false, ...EMPTY_RESULT,
      releasedBuffers: uploader.released.length, failure: error instanceof Error ? error.message : String(error) });
  } finally { uploader.destroyRemaining(); }
}

async function verifyGpuBufferResidencyRuntime(session: DeviceSession): Promise<boolean> {
  const runtime = new GpuResidencyRuntime(session, { maxResidentBytes: 64, maxUploadBytesPerFrame: 64 }, request => ({
    id: request.id, revision: request.revision, level: request.level,
    data: new Uint32Array([uploadValue(request)]).buffer, label: "Deep residency runtime adapter",
  }));
  try {
    runtime.controller.register({ id: "adapter", revision: 1, kind: "geometry", levels: [{ level: 0, byteLength: 4 }] });
    const result = await runtime.submit(1, [{ id: "adapter", desiredLevel: 0 }]);
    const resource = runtime.executor.get("adapter");
    if (!resource) return false;
    const value = await readStorageUint(session.device, resource.handle);
    return result.status === "applied" && value === uploadValue({ id: "adapter", kind: "geometry", revision: 1, level: 0,
      expectedByteLength: 4 } as GpuResidencyUploadRequest);
  } finally { runtime.dispose(); }
}

async function verifyCancellation(device: GPUDevice): Promise<boolean> {
  const controller = controllerFor("cancelled", [64]), uploader = new RealGpuBufferUploader(device);
  const executor = new GpuResidencyExecutor(controller, uploader);
  try {
    const gate = uploader.pause("cancelled:1:0");
    const running = executor.execute(controller.planFrame(1, [{ id: "cancelled", desiredLevel: 0 }]));
    const candidate = await gate.started;
    executor.cancel(); gate.continue();
    const result = await running;
    return result.commit.appliedUploads.length === 0 && result.commit.failedUploads.includes("cancelled")
      && candidate.released && executor.size === 0;
  } finally { executor.dispose(); uploader.destroyRemaining(); }
}

async function verifyActualDeviceLoss(): Promise<Pick<GpuResidencyProbeResult, "deviceLossObserved" | "staleCandidateReleased">> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { deviceLossObserved: false, staleCandidateReleased: false };
  const device = await adapter.requestDevice({ label: "Deep residency loss probe device" });
  const controller = controllerFor("loss"), uploader = new RealGpuBufferUploader(device);
  const executor = new GpuResidencyExecutor(controller, uploader, { deviceLost: device.lost });
  try {
    await executor.execute(controller.planFrame(1, [{ id: "loss", desiredLevel: 1 }]));
    const resident = executor.get("loss")!.handle, gate = uploader.pause("loss:1:0");
    const running = executor.execute(controller.planFrame(2, [{ id: "loss", desiredLevel: 0 }]));
    const candidate = await gate.started;
    device.destroy(); await device.lost; await Promise.resolve();
    const deviceLossObserved = executor.disposed && executor.size === 0 && resident.released;
    gate.continue();
    let staleRejected = false;
    try { await running; } catch (error) {
      staleRejected = error instanceof GpuResidencyExecutorError && error.code === "disposed";
    }
    return { deviceLossObserved, staleCandidateReleased: staleRejected && candidate.released };
  } finally {
    try { executor.dispose(); } catch { /* Probe cleanup is best effort after loss. */ }
    uploader.destroyRemaining(); device.destroy();
  }
}

function controllerFor(id: string, levels: readonly number[] = [128, 64]): ResourceResidencyController {
  const controller = new ResourceResidencyController({ maxResidentBytes: 256, maxUploadBytesPerFrame: 256 });
  controller.register({ id, revision: 1, kind: "geometry", levels: levels.map((byteLength, level) => ({ level, byteLength })) });
  return controller;
}

async function readUint(device: GPUDevice, source: GPUBuffer): Promise<number> {
  const readback = device.createBuffer({ label: "Deep residency probe readback", size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder({ label: "Deep residency probe readback commands" });
    encoder.copyBufferToBuffer(source, 0, readback, 0, 4);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
    await readback.mapAsync(GPUMapMode.READ);
    const value = new Uint32Array(readback.getMappedRange().slice(0))[0]!;
    readback.unmap(); return value;
  } finally { readback.destroy(); }
}

async function readStorageUint(device: GPUDevice, source: GPUBuffer): Promise<number> {
  const output = device.createBuffer({ label: "Deep residency storage probe output", size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  try {
    const module = device.createShaderModule({ label: "Deep residency storage probe shader", code: `
      @group(0) @binding(0) var<storage, read> source: array<u32>;
      @group(0) @binding(1) var<storage, read_write> output: array<u32>;
      @compute @workgroup_size(1) fn verify() { output[0] = source[0]; }
    ` });
    const pipeline = device.createComputePipeline({ label: "Deep residency storage probe pipeline",
      layout: "auto", compute: { module, entryPoint: "verify" } });
    const bindings = device.createBindGroup({ label: "Deep residency storage probe bindings",
      layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: output } },
      ] });
    const encoder = device.createCommandEncoder({ label: "Deep residency storage probe commands" });
    const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(1); pass.end(); device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    return await readUint(device, output);
  } finally { output.destroy(); }
}

function uploadKey(request: Pick<GpuResidencyUploadRequest, "id" | "revision" | "level">): string {
  return `${request.id}:${request.revision}:${request.level}`;
}
function uploadValue(request: GpuResidencyUploadRequest): number {
  let hash = 2166136261;
  for (const character of uploadKey(request)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}
function createGate(): UploadGate {
  let signalStarted!: (handle: GpuBufferHandle) => void, continueGate!: () => void;
  const started = new Promise<GpuBufferHandle>((resolve) => { signalStarted = resolve; });
  const resume = new Promise<void>((resolve) => { continueGate = resolve; });
  return { started, signalStarted, resume, continue: continueGate };
}
