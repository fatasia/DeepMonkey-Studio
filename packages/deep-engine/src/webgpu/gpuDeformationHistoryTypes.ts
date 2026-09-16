export interface GpuDeformationHistorySource {
  readonly output: GPUBuffer;
  readonly vertexCount: number;
  readonly outputStride: 32 | 48;
  /** Must advance when buffer identity, stride or vertex count changes. */
  readonly sourceRevision: number;
  readonly poseRevision: number;
  /** A 32-byte source cannot supply tangents. A 48-byte source must declare them explicitly. */
  readonly hasTangents?: boolean;
}

export interface GpuDeformationHistoryResult {
  readonly current: GPUBuffer;
  readonly previous: GPUBuffer;
  readonly vertexCount: number;
  readonly outputStride: 48;
  readonly hasTangents: boolean;
  readonly sourceRevision: number;
  readonly poseRevision: number;
  readonly historyValid: boolean;
  readonly updated: boolean;
}

/** Opaque identity token owned by one history instance until commit or cancel. */
export interface GpuDeformationHistoryStage { readonly result: GpuDeformationHistoryResult }

export function validateDeformationHistorySource(device: GPUDevice, source: GpuDeformationHistorySource): void {
  if (!source || !source.output) throw new TypeError("GPU deformation history requires a source buffer.");
  if (![source.sourceRevision, source.poseRevision].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError("GPU deformation history revisions must be nonnegative safe integers.");
  }
  if (source.outputStride !== 32 && source.outputStride !== 48) throw new RangeError("GPU deformation history stride must be 32 or 48.");
  if (!Number.isSafeInteger(source.vertexCount) || source.vertexCount < 1) throw new RangeError("GPU deformation history vertex count must be positive.");
  if (source.hasTangents !== undefined && typeof source.hasTangents !== "boolean") throw new TypeError("GPU deformation history hasTangents must be boolean.");
  if (source.outputStride === 32 && source.hasTangents) throw new Error("32-byte deformation output cannot supply tangents.");
  const bytes = source.vertexCount * 48, inputBytes = source.vertexCount * source.outputStride;
  if (!Number.isSafeInteger(bytes) || bytes > device.limits.maxBufferSize || bytes > device.limits.maxStorageBufferBindingSize
    || Math.ceil(source.vertexCount / 64) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new RangeError("GPU deformation history exceeds device limits.");
  }
  if (!Number.isSafeInteger(source.output.size) || source.output.size < inputBytes) throw new RangeError("GPU deformation history source buffer is too small.");
  if (source.output.mapState !== "unmapped") throw new Error("GPU deformation history source buffer must be unmapped.");
  const usage = source.outputStride === 32 ? GPUBufferUsage.STORAGE : GPUBufferUsage.COPY_SRC;
  if (!(source.output.usage & usage)) throw new Error("GPU deformation history source is missing required STORAGE or COPY_SRC usage.");
}
