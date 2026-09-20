import { FRAME_CAPTURE_SCHEMA, FRAME_CAPTURE_SCHEMA_VERSION, FrameCaptureSession,
  type FrameCaptureRecord, type FrameCaptureTimelineMarkerInput, type PassCaptureInput,
  type PbrFrameReadbackResult } from "@bim-studio/deep-engine";

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

let requested = false;
let publishedSession: StudioFrameCaptureSession | undefined;
let readbackEntries: StudioFrameReadbackEntry[] = [];

const DISABLED_FRAME = Object.freeze({ schema: FRAME_CAPTURE_SCHEMA, schemaVersion: FRAME_CAPTURE_SCHEMA_VERSION,
  frameId: "diagnostics-disabled", startedAtMs: 0, endedAtMs: 0,
  passes: Object.freeze([]), markers: Object.freeze([]) }) satisfies FrameCaptureRecord;

class StudioFrameCaptureSession extends FrameCaptureSession {
  private enabled = true;

  setEnabled(value: boolean): void {
    if (!value && this.activeFrameId) super.cancelFrame();
    this.enabled = value;
  }

  override beginFrame(frameId: string, startedAtMs: number, planHash?: string): void {
    if (this.enabled) super.beginFrame(frameId, startedAtMs, planHash);
  }

  override recordPass(pass: PassCaptureInput): void {
    if (this.enabled && this.activeFrameId) super.recordPass(pass);
  }

  override markTimeline(marker: FrameCaptureTimelineMarkerInput): void {
    if (this.enabled && this.activeFrameId) super.markTimeline(marker);
  }

  override endFrame(endedAtMs: number): FrameCaptureRecord {
    return this.enabled && this.activeFrameId ? super.endFrame(endedAtMs) : DISABLED_FRAME;
  }

  override cancelFrame(): string | undefined {
    return this.activeFrameId ? super.cancelFrame() : undefined;
  }
}

/** Author diagnostics are opt-in; normal Studio sessions never allocate a capture session. */
export function setStudioFrameCaptureRequested(value: boolean): void {
  requested = value;
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
  publishedSession = session instanceof StudioFrameCaptureSession ? session : undefined;
  publishedSession?.setEnabled(requested);
}

export function releaseStudioFrameCaptureSession(session: FrameCaptureSession | undefined): void {
  if (publishedSession === session) publishedSession = undefined;
}

export function readStudioFrameCaptureSnapshot(): StudioFrameCaptureSnapshot {
  return Object.freeze({
    available: publishedSession !== undefined,
    records: publishedSession?.records() ?? Object.freeze([]),
  });
}

export function createStudioFrameReadbackListener(): (results: readonly PbrFrameReadbackResult[]) => void {
  return results => {
    if (!requested || results.length === 0) return;
    readbackEntries = [...readbackEntries, { receivedAtMs: performance.now(), results }].slice(-MAX_READBACK_ENTRIES);
  };
}

export function readStudioFrameReadbacks(): readonly StudioFrameReadbackEntry[] {
  return readbackEntries;
}
