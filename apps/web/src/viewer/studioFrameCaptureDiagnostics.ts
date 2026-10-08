import { FRAME_CAPTURE_SCHEMA, FRAME_CAPTURE_SCHEMA_VERSION, FrameCaptureSession,
  type FrameCaptureRecord, type FrameCaptureTimelineMarkerInput, type PassCaptureInput,
  type PbrFrameReadbackResult, type PbrFrameReadbackRequest } from "@bim-studio/deep-engine";

export interface StudioFrameCaptureSnapshot {
  readonly available: boolean;
  readonly records: readonly FrameCaptureRecord[];
}

export interface StudioFrameReadbackEntry {
  readonly receivedAtMs: number;
  readonly results: readonly PbrFrameReadbackResult[];
}

/** Bounded readback history: newest frames survive, never unbounded byte growth. */
const MAX_READBACK_ENTRIES = 8;
const CAPTURE_FRAMES_PER_WINDOW = 2;

/** Explicit pass-isolation probe; ordinary two-frame diagnostics keep their original cost. */
export function studioFrameReadbackRequests(search = typeof location === "undefined" ? "" : location.search): readonly PbrFrameReadbackRequest[] {
  return [{ resourceId: "present-color" }, { resourceId: "linear-depth" },
    ...(new URLSearchParams(search).get("deep-capture-opaque") === "1"
      ? [{ resourceId: "opaque-hdr" as const }, { resourceId: "composited-hdr" as const }] : [])];
}

let requested = false;
let publishedSession: StudioFrameCaptureSession | undefined;
let readbackEntries: StudioFrameReadbackEntry[] = [];

const DISABLED_FRAME = Object.freeze({ schema: FRAME_CAPTURE_SCHEMA, schemaVersion: FRAME_CAPTURE_SCHEMA_VERSION,
  frameId: "diagnostics-disabled", startedAtMs: 0, endedAtMs: 0,
  passes: Object.freeze([]), markers: Object.freeze([]) }) satisfies FrameCaptureRecord;

class StudioFrameCaptureSession extends FrameCaptureSession {
  private enabled = false;
  private remainingFrames = 0;

  setEnabled(value: boolean): void {
    if (!value && this.activeFrameId) super.cancelFrame();
    this.enabled = value;
    this.remainingFrames = value ? CAPTURE_FRAMES_PER_WINDOW : 0;
  }

  /** 禁用帧返回 false:渲染循环据此整帧跳过捕获编码与 readback(合同见 r12/frameCapture)。 */
  override beginFrame(frameId: string, startedAtMs: number, planHash?: string): boolean | void {
    if (!this.enabled || this.remainingFrames === 0) return false;
    super.beginFrame(frameId, startedAtMs, planHash);
  }

  override recordPass(pass: PassCaptureInput): void {
    if (this.enabled && this.activeFrameId) super.recordPass(pass);
  }

  override markTimeline(marker: FrameCaptureTimelineMarkerInput): void {
    if (this.enabled && this.activeFrameId) super.markTimeline(marker);
  }

  override endFrame(endedAtMs: number): FrameCaptureRecord {
    if (!this.enabled || !this.activeFrameId) return DISABLED_FRAME;
    const record = super.endFrame(endedAtMs);
    this.remainingFrames -= 1;
    return record;
  }

  override cancelFrame(): string | undefined {
    return this.activeFrameId ? super.cancelFrame() : undefined;
  }
}

/** Author diagnostics are opt-in; normal Studio sessions never allocate a capture session. */
export function setStudioFrameCaptureRequested(value: boolean): void {
  requested = value;
  if (!value) readbackEntries = [];
  publishedSession?.setEnabled(value);
}

export function createRequestedStudioFrameCaptureSession(): FrameCaptureSession | undefined {
  if (!requested) return undefined;
  return new StudioFrameCaptureSession({
    budget: {
      maxFrames: 24,
      maxPassesPerFrame: 256,
      maxMarkersPerFrame: 64,
      maxSourceMapRefsPerPass: 512,
      maxStringLength: 256,
    },
  });
}

export function publishStudioFrameCaptureSession(session: FrameCaptureSession | undefined): void {
  const next = session instanceof StudioFrameCaptureSession ? session : undefined;
  if (publishedSession !== next) readbackEntries = [];
  publishedSession = next;
  publishedSession?.setEnabled(requested);
}

export function releaseStudioFrameCaptureSession(session: FrameCaptureSession | undefined): void {
  if (publishedSession === session) {
    publishedSession = undefined;
    readbackEntries = [];
  }
}

export function readStudioFrameCaptureSnapshot(): StudioFrameCaptureSnapshot {
  return Object.freeze({
    available: publishedSession !== undefined,
    records: publishedSession?.records() ?? Object.freeze([]),
  });
}

export function createStudioFrameReadbackListener(session: FrameCaptureSession): (results: readonly PbrFrameReadbackResult[]) => void {
  return results => {
    if (!requested || publishedSession !== session || results.length === 0) return;
    readbackEntries = [...readbackEntries, { receivedAtMs: performance.now(), results }].slice(-MAX_READBACK_ENTRIES);
  };
}

export function readStudioFrameReadbacks(): readonly StudioFrameReadbackEntry[] {
  return readbackEntries;
}
