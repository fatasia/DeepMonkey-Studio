export interface FrameCaptureBufferReadbackRequest {
  readonly frameId: string;
  readonly resourceId: string;
  readonly source: GPUBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface FrameCaptureReadbackOptions {
  readonly maxBytes?: number;
  /** Starts at encoding so abandoned, unsubmitted tickets also release their staging buffer. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface FrameCaptureTextureReadbackRequest {
  readonly frameId: string;
  readonly resourceId: string;
  readonly source: GPUTexture;
  readonly mipLevel?: number;
  readonly origin?: Readonly<{ x?: number; y?: number }>;
  readonly width: number;
  readonly height: number;
}

export interface FrameCaptureTextureSnapshot {
  readonly frameId: string;
  readonly resourceId: string;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  /** Tightly packed output stride; WebGPU's 256-byte staging padding has been removed. */
  readonly bytesPerRow: number;
  readonly bytes: Uint8Array;
}

export interface FrameCaptureTextureReadback {
  readonly frameId: string;
  readonly resourceId: string;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readAfterSubmit(): Promise<FrameCaptureTextureSnapshot>;
  cancel(): void;
}

export interface FrameCaptureBufferReadback {
  readonly frameId: string;
  readonly resourceId: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  /** Caller must successfully submit the encoder before calling this. Never submits work itself. */
  readAfterSubmit(): Promise<Uint8Array>;
  cancel(): void;
}

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 5_000;

function readbackError(message: string, name: "AbortError" | "TimeoutError"): Error {
  const error = new Error(message); error.name = name; return error;
}

function readbackLimits(options: FrameCaptureReadbackOptions): { maximum: number; timeout: number } {
  const maximum = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 4) throw new RangeError("Capture readback byte budget must be a positive safe integer of at least 4.");
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new RangeError("Capture readback timeout is invalid.");
  return { maximum, timeout };
}

function validateIds(frameId: string, resourceId: string): void {
  for (const id of [frameId, resourceId]) {
    if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_.:/-]{0,255}$/u.test(id)) throw new TypeError("Capture readback requires bounded frame/resource IDs.");
  }
}

function validate(request: FrameCaptureBufferReadbackRequest, options: FrameCaptureReadbackOptions): number {
  validateIds(request.frameId, request.resourceId);
  const { maximum, timeout } = readbackLimits(options);
  const { byteOffset, byteLength, source } = request;
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset % 4 !== 0
    || !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength % 4 !== 0
    || byteLength > maximum || byteOffset > source.size - byteLength) {
    throw new RangeError("Capture readback range must be 4-byte aligned, nonempty, and within the source and byte budget.");
  }
  if ((source.usage & GPUBufferUsage.COPY_SRC) === 0 || source.mapState !== "unmapped") {
    throw new Error("Capture readback source must be an unmapped COPY_SRC buffer.");
  }
  return timeout;
}

/** Encodes a bounded diagnostic snapshot without owning or modifying the caller's source buffer. */
export function encodeFrameCaptureBufferReadback(device: GPUDevice, encoder: GPUCommandEncoder,
  request: FrameCaptureBufferReadbackRequest, options: FrameCaptureReadbackOptions = {}): FrameCaptureBufferReadback {
  const timeout = validate(request, options);
  if (request.byteLength > device.limits.maxBufferSize) throw new RangeError("Capture readback buffer exceeds the device buffer limit.");
  if (options.signal?.aborted) throw readbackError("Capture readback cancelled", "AbortError");
  const staging = device.createBuffer({ label: `Capture ${request.resourceId}`, size: request.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try { encoder.copyBufferToBuffer(request.source, request.byteOffset, staging, 0, request.byteLength); }
  catch (error) { staging.destroy(); throw error; }
  return createTicket(device, staging, request.frameId, request.resourceId, request.byteOffset, request.byteLength, timeout, options.signal);
}

const UNCOMPRESSED_FORMAT_BYTES: Readonly<Record<string, number>> = Object.freeze({
  r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1,
  r16uint: 2, r16sint: 2, r16float: 2, rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2,
  r32uint: 4, r32sint: 4, r32float: 4, rg16uint: 4, rg16sint: 4, rg16float: 4,
  rgba8unorm: 4, "rgba8unorm-srgb": 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4,
  bgra8unorm: 4, "bgra8unorm-srgb": 4, rgb10a2unorm: 4, rg11b10ufloat: 4,
  rg32uint: 8, rg32sint: 8, rg32float: 8, rgba16uint: 8, rgba16sint: 8, rgba16float: 8,
  rgba32uint: 16, rgba32sint: 16, rgba32float: 16,
});

/** Encodes a single-layer, uncompressed 2D texture snapshot and strips WebGPU row padding on read. */
export function encodeFrameCaptureTextureReadback(device: GPUDevice, encoder: GPUCommandEncoder,
  request: FrameCaptureTextureReadbackRequest, options: FrameCaptureReadbackOptions = {}): FrameCaptureTextureReadback {
  validateIds(request.frameId, request.resourceId);
  const { maximum, timeout } = readbackLimits(options);
  if (options.signal?.aborted) throw readbackError("Capture readback cancelled", "AbortError");
  const { source } = request, mipLevel = request.mipLevel ?? 0;
  const x = request.origin?.x ?? 0, y = request.origin?.y ?? 0;
  const bytesPerPixel = UNCOMPRESSED_FORMAT_BYTES[source.format];
  if (bytesPerPixel === undefined) throw new Error(`Capture readback texture format is compressed or unsupported: ${source.format}.`);
  if (source.dimension !== "2d" || source.depthOrArrayLayers !== 1 || source.sampleCount !== 1
    || (source.usage & GPUTextureUsage.COPY_SRC) === 0) {
    throw new Error("Capture readback requires a single-layer, single-sample 2D COPY_SRC texture.");
  }
  if (!Number.isSafeInteger(mipLevel) || mipLevel < 0 || mipLevel >= source.mipLevelCount
    || ![x, y, request.width, request.height].every(Number.isSafeInteger)
    || x < 0 || y < 0 || request.width < 1 || request.height < 1) {
    throw new RangeError("Capture readback texture region is invalid.");
  }
  const divisor = 2 ** mipLevel;
  const mipWidth = Math.max(1, Math.floor(source.width / divisor));
  const mipHeight = Math.max(1, Math.floor(source.height / divisor));
  if (x > mipWidth - request.width || y > mipHeight - request.height) throw new RangeError("Capture readback texture region exceeds its mip level.");
  const bytesPerRow = request.width * bytesPerPixel;
  const paddedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;
  const stagingBytes = paddedBytesPerRow * request.height;
  if (!Number.isSafeInteger(stagingBytes) || stagingBytes > maximum || stagingBytes > device.limits.maxBufferSize) {
    throw new RangeError("Capture readback texture exceeds the staging byte budget.");
  }
  const staging = device.createBuffer({ label: `Capture ${request.resourceId}`, size: stagingBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    encoder.copyTextureToBuffer({ texture: source, mipLevel, origin: { x, y, z: 0 } },
      { buffer: staging, bytesPerRow: paddedBytesPerRow, rowsPerImage: request.height },
      { width: request.width, height: request.height, depthOrArrayLayers: 1 });
  } catch (error) { staging.destroy(); throw error; }
  const raw = createTicket(device, staging, request.frameId, request.resourceId, 0, stagingBytes, timeout, options.signal);
  return Object.freeze({ frameId: request.frameId, resourceId: request.resourceId,
    width: request.width, height: request.height, format: source.format, cancel: () => raw.cancel(),
    async readAfterSubmit(): Promise<FrameCaptureTextureSnapshot> {
      const padded = await raw.readAfterSubmit();
      const bytes = new Uint8Array(bytesPerRow * request.height);
      for (let row = 0; row < request.height; row++) {
        bytes.set(padded.subarray(row * paddedBytesPerRow, row * paddedBytesPerRow + bytesPerRow), row * bytesPerRow);
      }
      return Object.freeze({ frameId: request.frameId, resourceId: request.resourceId,
        width: request.width, height: request.height, format: source.format, bytesPerRow, bytes });
    },
  });
}

function createTicket(device: GPUDevice, buffer: GPUBuffer, frameId: string, resourceId: string,
  byteOffset: number, byteLength: number, timeoutMs: number, signal?: AbortSignal): FrameCaptureBufferReadback {
  let staging: GPUBuffer | undefined = buffer;
  let started = false, failure: Error | undefined, settled = false;
  let rejectRead: ((reason: Error) => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  // Cancellation can precede readAfterSubmit; retain the reason without an unhandled rejection.
  void interrupted.catch(() => {});
  const release = () => {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    const owned = staging; staging = undefined;
    if (owned) { try { if (owned.mapState === "mapped") owned.unmap(); } finally { owned.destroy(); } }
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true; failure = error;
    rejectRead?.(error); release();
  };
  const abort = () => fail(readbackError("Capture readback cancelled", "AbortError"));
  const timer = setTimeout(() => fail(readbackError("Capture readback timed out", "TimeoutError")), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  void device.lost.then(info => fail(new Error(`Capture readback device lost: ${info.reason}`)),
    () => fail(new Error("Capture readback device loss notification failed")));
  if (signal?.aborted) abort();
  return Object.freeze({ frameId, resourceId, byteOffset, byteLength,
    cancel: abort,
    async readAfterSubmit() {
      if (failure) throw failure;
      if (started || settled) throw new Error("Capture readback ticket may only be read once.");
      started = true;
      try {
        // The staging offset is always 0 (8-byte aligned), regardless of source offset.
        await Promise.race([staging!.mapAsync(GPUMapMode.READ, 0, byteLength), interrupted]);
        if (failure) throw failure;
        const bytes = new Uint8Array(staging!.getMappedRange(0, byteLength)).slice();
        settled = true;
        return bytes;
      } finally { settled = true; release(); }
    },
  });
}
