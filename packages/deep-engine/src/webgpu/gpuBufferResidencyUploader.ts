import type { GpuResidencyUploader, GpuResidencyUploadRequest,
  GpuResidencyUploadResult } from "../streaming/index.js";
import type { DeviceSession } from "./deviceSession.js";

export interface GpuBufferResidencySource {
  readonly id: string;
  readonly revision: number;
  readonly level: number;
  readonly data: ArrayBuffer | ArrayBufferView<ArrayBuffer>;
  readonly label?: string;
  readonly usage?: GPUBufferUsageFlags;
}

export type GpuBufferResidencySourceProvider =
  (request: GpuResidencyUploadRequest) => GpuBufferResidencySource | Promise<GpuBufferResidencySource>;

/** 将驻留调度计划落成由 DeviceSession 独占的 GPUBuffer。 */
export class GpuBufferResidencyUploader implements GpuResidencyUploader<GPUBuffer> {
  constructor(private readonly session: DeviceSession,
    private readonly sourceFor: GpuBufferResidencySourceProvider,
    private readonly defaultUsage: GPUBufferUsageFlags = GPUBufferUsage.STORAGE) {}

  async upload(request: GpuResidencyUploadRequest): Promise<GpuResidencyUploadResult<GPUBuffer>> {
    if (request.kind !== "geometry") throw new TypeError("GPU buffer residency uploader only accepts geometry resources.");
    if (request.signal.aborted) throw cancellation(request.signal);
    const source = await this.sourceFor(request);
    if (request.signal.aborted) throw cancellation(request.signal);
    if (!source || source.id !== request.id || source.revision !== request.revision) {
      throw new Error(`Residency source identity differs from plan: ${request.id}.`);
    }
    if (source.level !== request.level) {
      throw new Error(`Residency source level differs from plan: ${request.id}.`);
    }
    const bytes = source.data;
    if (!(bytes instanceof ArrayBuffer)
      && !(ArrayBuffer.isView(bytes) && bytes.buffer instanceof ArrayBuffer)) {
      throw new Error(`Residency source byte count differs from plan: ${request.id}.`);
    }
    const allocatedByteLength = alignedBufferSize(bytes.byteLength);
    if (allocatedByteLength !== request.expectedByteLength) {
      throw new Error(`Residency source byte count differs from plan: ${request.id}.`);
    }
    const device = this.session.device, limit = bufferLimit(device);
    if (allocatedByteLength > limit) {
      throw new Error(`Residency source exceeds GPU maxBufferSize: ${request.id}.`);
    }
    const checks: Promise<GPUError | null>[] = [];
    let buffer: GPUBuffer | undefined, depth = 0, workError: unknown;
    try {
      for (const filter of ["validation", "out-of-memory", "internal"] as const) {
        device.pushErrorScope(filter); depth += 1;
      }
      buffer = this.session.own(device.createBuffer({
        label: source.label ?? `Deep streamed ${request.id} LOD ${request.level}`,
        size: allocatedByteLength,
        usage: (source.usage ?? this.defaultUsage) | GPUBufferUsage.COPY_DST,
      }));
      device.queue.writeBuffer(buffer, 0, alignedUploadBytes(bytes, allocatedByteLength));
      if (request.signal.aborted) throw cancellation(request.signal);
    } catch (error) { workError = error; }
    finally {
      while (depth-- > 0) {
        try { checks.push(device.popErrorScope()); }
        catch (error) { checks.push(Promise.reject(error)); }
      }
    }
    try {
      let validationError: unknown;
      try { await waitForValidation(checks, request.signal); }
      catch (error) { validationError = error; }
      if (workError !== undefined) throw workError;
      if (validationError !== undefined) throw validationError;
      if (request.signal.aborted) throw cancellation(request.signal);
      return Object.freeze({ handle: buffer!, byteLength: allocatedByteLength });
    } catch (error) {
      if (buffer) this.session.release(buffer);
      throw error;
    }
  }

  release(handle: GPUBuffer): void { this.session.release(handle); }
}

function alignedBufferSize(bytes: number): number {
  const size = Math.max(4, Math.ceil(bytes / 4) * 4);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(size)) {
    throw new Error("Invalid GPU buffer residency byte length.");
  }
  return size;
}
function alignedUploadBytes(bytes: ArrayBuffer | ArrayBufferView<ArrayBuffer>, size: number) {
  if (bytes.byteLength === size) return bytes;
  const padded = new Uint8Array(size);
  padded.set(bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return padded;
}
function bufferLimit(device: GPUDevice): number {
  const limit = device.limits.maxBufferSize;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid GPU maxBufferSize limit.");
  return limit;
}
async function waitForValidation(checks: readonly Promise<GPUError | null>[], signal: AbortSignal): Promise<void> {
  const checked = Promise.all(checks).then(errors => {
    const error = errors.find(value => value !== null);
    if (error) throw new Error(`GPU buffer residency upload failed: ${error.message}`);
  });
  if (signal.aborted) { void checked.catch(() => {}); throw cancellation(signal); }
  let rejectCancellation!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const onAbort = (): void => rejectCancellation(cancellation(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try { await Promise.race([checked, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
function cancellation(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("GPU residency upload cancelled."); error.name = "AbortError"; return error;
}
