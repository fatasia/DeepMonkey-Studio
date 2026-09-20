import { encodeFrameCaptureTextureReadback, type FrameCaptureTextureReadback } from "./frameCaptureReadback.js";

/** Fixed whitelist of PBR resources a diagnostic host may snapshot. Never guessed, never implicitly extended. */
export const PBR_FRAME_READBACK_RESOURCES = Object.freeze(["present-color", "opaque-hdr", "linear-depth"] as const);
export type PbrFrameReadbackResourceId = (typeof PBR_FRAME_READBACK_RESOURCES)[number];

export interface PbrFrameReadbackRequest {
  readonly resourceId: PbrFrameReadbackResourceId;
}

export interface PbrFrameReadbackPlanOptions {
  readonly requests: readonly PbrFrameReadbackRequest[];
  /** Combined staging byte budget across all requests of one frame. */
  readonly maxBytesPerFrame?: number;
  /** Starts at encoding so abandoned, unsubmitted tickets also release their staging buffers. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface PbrFrameReadbackSnapshot {
  readonly frameId: string;
  readonly resourceId: PbrFrameReadbackResourceId;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly bytesPerRow: number;
  readonly bytes: Uint8Array;
}

export interface PbrFrameReadbackUnavailable {
  readonly frameId: string;
  readonly resourceId: PbrFrameReadbackResourceId;
  readonly reason: string;
}

export type PbrFrameReadbackResult = PbrFrameReadbackSnapshot | PbrFrameReadbackUnavailable;

export function isPbrFrameReadbackSnapshot(result: PbrFrameReadbackResult): result is PbrFrameReadbackSnapshot {
  return "bytes" in result && result.bytes instanceof Uint8Array;
}

const DEFAULT_MAX_BYTES_PER_FRAME = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Plans per-frame readbacks for a fixed whitelist of PBR resources. Encoding happens on the frame
 * encoder before submit; the staging buffers are only mapped after the queue has actually submitted,
 * and a resource that cannot be captured this frame degrades to an explicit unavailable record
 * instead of failing the render loop.
 */
export class PbrFrameReadbackPlan {
  private readonly requestsList: readonly PbrFrameReadbackRequest[];
  private readonly maxBytesPerFrame: number;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private frame: {
    readonly frameId: string;
    readonly tickets: ReadonlyArray<{ readonly resourceId: PbrFrameReadbackResourceId;
      readonly ticket: FrameCaptureTextureReadback }>;
    readonly unavailable: ReadonlyMap<PbrFrameReadbackResourceId, PbrFrameReadbackUnavailable>;
  } | undefined;

  constructor(options: PbrFrameReadbackPlanOptions) {
    if (!Array.isArray(options.requests) || options.requests.length === 0
      || options.requests.length > PBR_FRAME_READBACK_RESOURCES.length) {
      throw new TypeError("PBR frame readback requires between one and whitelist-size requests.");
    }
    const seen = new Set<string>();
    for (const request of options.requests) {
      if (!request || typeof request !== "object" || !PBR_FRAME_READBACK_RESOURCES.includes(request.resourceId)) {
        throw new TypeError(`PBR frame readback resource is outside the fixed whitelist: ${String((request as { resourceId?: unknown })?.resourceId)}.`);
      }
      if (seen.has(request.resourceId)) throw new TypeError(`PBR frame readback requests must not repeat: ${request.resourceId}.`);
      seen.add(request.resourceId);
    }
    this.requestsList = Object.freeze([...options.requests]);
    this.maxBytesPerFrame = options.maxBytesPerFrame ?? DEFAULT_MAX_BYTES_PER_FRAME;
    if (!Number.isSafeInteger(this.maxBytesPerFrame) || this.maxBytesPerFrame < 4) {
      throw new RangeError("PBR frame readback per-frame byte budget must be a positive safe integer of at least 4.");
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError("PBR frame readback timeout is invalid.");
    }
    this.signal = options.signal;
  }

  get requestCount(): number { return this.requestsList.length; }

  /** Encodes staging copies on the caller's frame encoder. Resource identity is the caller's contract. */
  beginFrame(frameId: string, device: GPUDevice, encoder: GPUCommandEncoder,
    textures: Readonly<Record<PbrFrameReadbackResourceId, GPUTexture | undefined>>): void {
    if (this.frame !== undefined) {
      throw new Error("PBR frame readback frame is still open; collect or cancel before encoding the next frame.");
    }
    if (this.signal?.aborted) return;
    let remainingBytes = this.maxBytesPerFrame;
    const unavailable = new Map<PbrFrameReadbackResourceId, PbrFrameReadbackUnavailable>();
    const tickets: Array<{ resourceId: PbrFrameReadbackResourceId; ticket: FrameCaptureTextureReadback }> = [];
    for (const request of this.requestsList) {
      const source = textures[request.resourceId];
      const blocker = readbackBlocker(source, remainingBytes);
      if (blocker !== undefined) {
        unavailable.set(request.resourceId, Object.freeze({ frameId, resourceId: request.resourceId, reason: blocker }));
        continue;
      }
      try {
        const ticket = encodeFrameCaptureTextureReadback(device, encoder, {
          frameId, resourceId: request.resourceId, source: source!,
          width: source!.width, height: source!.height,
        }, this.signal === undefined
          ? { maxBytes: remainingBytes, timeoutMs: this.timeoutMs }
          : { maxBytes: remainingBytes, timeoutMs: this.timeoutMs, signal: this.signal });
        remainingBytes -= stagingBytes(source!);
        tickets.push({ resourceId: request.resourceId, ticket });
      } catch (error) {
        unavailable.set(request.resourceId, Object.freeze({ frameId, resourceId: request.resourceId,
          reason: `readback encode rejected: ${(error as Error).message}` }));
      }
    }
    this.frame = { frameId, tickets: Object.freeze(tickets), unavailable };
  }

  /**
   * Must be called only after the encoder has been submitted; the GPU submission itself is not owned
   * here. Releases the frame slot immediately so the render loop can encode its next frame while the
   * staging maps are still settling.
   */
  collectAfterSubmit(): Promise<readonly PbrFrameReadbackResult[]> {
    const frame = this.frame;
    if (frame === undefined) throw new Error("PBR frame readback has no open frame to collect.");
    this.frame = undefined;
    const settled = Promise.allSettled(frame.tickets.map(async ({ resourceId, ticket }) => {
      const snapshot = await ticket.readAfterSubmit();
      return Object.freeze({ frameId: frame.frameId, resourceId,
        width: snapshot.width, height: snapshot.height, format: snapshot.format,
        bytesPerRow: snapshot.bytesPerRow, bytes: snapshot.bytes }) satisfies PbrFrameReadbackSnapshot;
    }));
    return settled.then(outcomes => {
      const byResource = new Map<PbrFrameReadbackResourceId, PromiseSettledResult<PbrFrameReadbackSnapshot>>();
      frame.tickets.forEach(({ resourceId }, index) => byResource.set(resourceId, outcomes[index]!));
      const results: PbrFrameReadbackResult[] = [];
      for (const request of this.requestsList) {
        const unavailable = frame.unavailable.get(request.resourceId);
        if (unavailable !== undefined) { results.push(unavailable); continue; }
        const outcome = byResource.get(request.resourceId);
        if (outcome === undefined) {
          results.push(Object.freeze({ frameId: frame.frameId, resourceId: request.resourceId, reason: "readback was not encoded" }));
        } else if (outcome.status === "fulfilled") {
          results.push(outcome.value);
        } else {
          results.push(Object.freeze({ frameId: frame.frameId, resourceId: request.resourceId,
            reason: `readback failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}` }));
        }
      }
      return Object.freeze(results);
    });
  }

  cancel(): void {
    for (const { ticket } of this.frame?.tickets ?? []) ticket.cancel();
    this.frame = undefined;
  }
}

function stagingBytes(texture: GPUTexture): number {
  const formatBytes: Record<string, number> = { "rgba8unorm": 4, "rgba8unorm-srgb": 4, "bgra8unorm": 4,
    "bgra8unorm-srgb": 4, "rgba16float": 8, "rgba32float": 16, "rg11b10ufloat": 4, "rgb10a2unorm": 4,
    "r32float": 4, "r16float": 2, "r8unorm": 1 };
  const bytesPerPixel = formatBytes[texture.format];
  if (bytesPerPixel === undefined) return Number.MAX_SAFE_INTEGER;
  const padded = Math.ceil(texture.width * bytesPerPixel / 256) * 256;
  return padded * texture.height;
}

function readbackBlocker(source: GPUTexture | undefined, remainingBytes: number): string | undefined {
  if (source === undefined) return "resource is absent this frame";
  if ((source.usage & GPUTextureUsage.COPY_SRC) === 0) return "resource lacks COPY_SRC usage this frame";
  if (source.dimension !== "2d" || source.depthOrArrayLayers !== 1 || source.sampleCount !== 1) {
    return "resource is not a single-layer single-sample 2D texture this frame";
  }
  if (stagingBytes(source) > remainingBytes) return "resource exceeds the remaining per-frame readback byte budget";
  return undefined;
}
