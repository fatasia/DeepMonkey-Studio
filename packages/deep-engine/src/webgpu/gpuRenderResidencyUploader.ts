import type { GeometryResource } from "../renderPacketTypes.js";
import type {
  GpuResidencyUploader,
  GpuResidencyUploadRequest,
  GpuResidencyUploadResult,
} from "../streaming/index.js";
import type { DeviceSession } from "./deviceSession.js";
import {
  GpuGeometryResidencyUploader,
  type GpuGeometryResidencyHandle,
} from "./gpuGeometryResidencyUploader.js";
import {
  GpuTextureResidencyUploader,
  type GpuTextureResidencyHandle,
  type GpuTextureResidencySource,
} from "./gpuTextureResidencyUploader.js";

export type GpuRenderResidencySource =
  | Readonly<{ kind: "geometry"; source: GeometryResource }>
  | Readonly<{ kind: "texture"; source: GpuTextureResidencySource }>;

export type GpuRenderResidencySourceProvider =
  (request: GpuResidencyUploadRequest) => GpuRenderResidencySource | Promise<GpuRenderResidencySource>;

export type GpuRenderResidencyHandle = GpuGeometryResidencyHandle | GpuTextureResidencyHandle;
export type GpuRenderResidencySourceId = (request: GpuResidencyUploadRequest) => string;

/** Dispatches one global residency budget to draw-ready geometry and sampled texture uploaders. */
export class GpuRenderResidencyUploader implements GpuResidencyUploader<GpuRenderResidencyHandle> {
  private readonly geometries: GpuGeometryResidencyUploader;
  private readonly textures: GpuTextureResidencyUploader;

  constructor(session: DeviceSession, sourceFor: GpuRenderResidencySourceProvider,
    private readonly sourceIdFor: GpuRenderResidencySourceId = request => request.id, meshlets = false) {
    this.geometries = new GpuGeometryResidencyUploader(session, async request => {
      const source = await sourceFor(request);
      if (source.kind !== "geometry") throw sourceKindError(request, source.kind);
      return source.source;
    }, meshlets);
    this.textures = new GpuTextureResidencyUploader(session, async request => {
      const source = await sourceFor(request);
      if (source.kind !== "texture") throw sourceKindError(request, source.kind);
      return source.source;
    });
  }

  upload(request: GpuResidencyUploadRequest): Promise<GpuResidencyUploadResult<GpuRenderResidencyHandle>> {
    const sourceRequest = this.sourceRequest(request);
    return request.kind === "geometry" ? this.geometries.upload(sourceRequest) : this.textures.upload(sourceRequest);
  }

  release(handle: GpuRenderResidencyHandle): void {
    if (handle.kind === "geometry") this.geometries.release(handle);
    else this.textures.release(handle);
  }

  private sourceRequest(request: GpuResidencyUploadRequest): GpuResidencyUploadRequest {
    const id = this.sourceIdFor(request);
    if (typeof id !== "string" || !id.length) throw new TypeError("Render residency source id is invalid.");
    return id === request.id ? request : Object.freeze({ ...request, id });
  }
}

function sourceKindError(request: GpuResidencyUploadRequest, actual: string): TypeError {
  return new TypeError(`Render residency source kind differs for ${request.id}: expected ${request.kind}, received ${actual}.`);
}
