import { validateGeometries, geometryGpuByteLength } from "../renderPacketGeometry.js";
import type { GeometryResource } from "../renderPacketTypes.js";
import type {
  GpuResidencyUploader,
  GpuResidencyUploadRequest,
  GpuResidencyUploadResult,
} from "../streaming/index.js";
import type { DeviceSession } from "./deviceSession.js";
import { bindGpuResidencyHandleDevice } from "./gpuResidencyDeviceAffinity.js";
import { MeshBuffers } from "./meshBuffers.js";
import { PACKET_MESHLET_STAGE_BYTES, type PacketMeshletBudget } from "./packetMeshletSource.js";
import { failWithResourceCleanup } from "./resourceCleanup.js";

export interface GpuGeometryResidencyHandle {
  readonly kind: "geometry";
  readonly mesh: MeshBuffers;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly level: number;
}

export type GpuGeometryResidencySourceProvider =
  (request: GpuResidencyUploadRequest) => GeometryResource | Promise<GeometryResource>;

/** Uploads a complete draw-ready mesh while the residency executor owns publication and release. */
export class GpuGeometryResidencyUploader implements GpuResidencyUploader<GpuGeometryResidencyHandle> {
  private readonly meshletBudget: PacketMeshletBudget | undefined;
  constructor(private readonly session: DeviceSession,
    private readonly sourceFor: GpuGeometryResidencySourceProvider, meshlets = false) {
    this.meshletBudget = meshlets ? { remainingBytes: PACKET_MESHLET_STAGE_BYTES } : undefined;
  }

  async upload(request: GpuResidencyUploadRequest): Promise<GpuResidencyUploadResult<GpuGeometryResidencyHandle>> {
    if (request.kind !== "geometry") throw new TypeError("GPU geometry residency uploader only accepts geometry resources.");
    if (request.signal.aborted) throw cancellation(request.signal);
    const source = await this.sourceFor(request);
    if (request.signal.aborted) throw cancellation(request.signal);
    if (!source || source.id !== request.id) {
      throw new Error(`Geometry residency source identity differs from plan: ${request.id}.`);
    }
    if (source.revision !== request.revision) {
      throw new Error(`Geometry residency source revision differs from plan: ${request.id}.`);
    }
    validateGeometries(new Map([[source.id, source]]));
    const byteLength = geometryGpuByteLength(source);
    if (byteLength !== request.expectedByteLength) {
      throw new Error(`Geometry residency source byte count differs from plan: ${request.id}.`);
    }
    const device = this.session.device, checks: Promise<GPUError | null>[] = [];
    let mesh: MeshBuffers | undefined, depth = 0, workError: unknown;
    try {
      for (const filter of ["validation", "out-of-memory", "internal"] as const) {
        device.pushErrorScope(filter); depth += 1;
      }
      mesh = new MeshBuffers(this.session, source, this.meshletBudget);
      if (request.signal.aborted) throw cancellation(request.signal);
    } catch (error) { workError = error; }
    finally {
      while (depth-- > 0) {
        try { checks.push(device.popErrorScope()); }
        catch (error) { checks.push(Promise.reject(error)); }
      }
    }
    try {
      const validationError = await validateGpuWork(checks, request.signal);
      if (workError !== undefined) throw workError;
      if (validationError) throw new Error(`GPU geometry residency upload failed: ${validationError.message}`);
      if (request.signal.aborted) throw cancellation(request.signal);
      const handle = bindGpuResidencyHandleDevice(Object.freeze({ kind: "geometry" as const,
        mesh: mesh!, sourceId: source.id, sourceRevision: source.revision,
        level: request.level }), device);
      return Object.freeze({
        handle,
        byteLength,
      });
    } catch (error) {
      failWithResourceCleanup(error, "GPU geometry residency upload failed.", [() => mesh?.dispose()]);
    }
  }

  release(handle: GpuGeometryResidencyHandle): void { handle.mesh.dispose(); }
}

function cancellation(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("GPU geometry residency upload cancelled."); error.name = "AbortError"; return error;
}

async function validateGpuWork(checks: readonly Promise<GPUError | null>[], signal: AbortSignal): Promise<GPUError | null> {
  const checked = Promise.all(checks).then(errors => errors.find(value => value !== null) ?? null);
  if (signal.aborted) { void checked.catch(() => {}); throw cancellation(signal); }
  let rejectCancellation!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const onAbort = (): void => rejectCancellation(cancellation(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([checked, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
