import { afterEach, describe, expect, it } from "vitest";
import {
  createRequestedStudioFrameCaptureSession,
  publishStudioFrameCaptureSession,
  readStudioFrameCaptureSnapshot,
  releaseStudioFrameCaptureSession,
  setStudioFrameCaptureRequested,
} from "./studioFrameCaptureDiagnostics";

afterEach(() => {
  setStudioFrameCaptureRequested(false);
  publishStudioFrameCaptureSession(undefined);
});

describe("studioFrameCaptureDiagnostics", () => {
  it("does not allocate capture storage outside an explicit diagnostics session", () => {
    expect(createRequestedStudioFrameCaptureSession()).toBeUndefined();
    expect(readStudioFrameCaptureSnapshot()).toEqual({ available: false, records: [] });
  });

  it("publishes bounded real frame capture records and releases only their owner", () => {
    setStudioFrameCaptureRequested(true);
    const session = createRequestedStudioFrameCaptureSession();
    expect(session?.budget.maxFrames).toBe(24);
    publishStudioFrameCaptureSession(session);
    session?.beginFrame("frame-1", 10, "plan-a");
    session?.recordPass({ passId: "opaque", kind: "render", reads: [], writes: ["color"], sourceMapRefs: [
      { moduleId: "material.main", stage: "fragment", nodeId: "baseColor", generatedLine: 18 },
    ] });
    session?.endFrame(12);

    expect(readStudioFrameCaptureSnapshot().records[0]?.passes[0]?.sourceMapRefs[0]?.nodeId).toBe("baseColor");
    setStudioFrameCaptureRequested(false);
    session?.beginFrame("frame-ignored", 20);
    session?.recordPass({ passId: "ignored", kind: "render", reads: [], writes: [] });
    session?.endFrame(21);
    expect(readStudioFrameCaptureSnapshot().records).toHaveLength(1);
    releaseStudioFrameCaptureSession(undefined);
    expect(readStudioFrameCaptureSnapshot().available).toBe(true);
    releaseStudioFrameCaptureSession(session);
    expect(readStudioFrameCaptureSnapshot()).toEqual({ available: false, records: [] });
  });
});
