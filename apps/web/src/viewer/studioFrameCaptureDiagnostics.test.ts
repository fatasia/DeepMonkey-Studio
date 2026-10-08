import { afterEach, describe, expect, it } from "vitest";
import type { PbrFrameReadbackResult } from "@bim-studio/deep-engine";
import {
  createRequestedStudioFrameCaptureSession,
  createStudioFrameReadbackListener,
  publishStudioFrameCaptureSession,
  readStudioFrameCaptureSnapshot,
  readStudioFrameReadbacks,
  releaseStudioFrameCaptureSession,
  setStudioFrameCaptureRequested,
  studioFrameReadbackRequests,
} from "./studioFrameCaptureDiagnostics";

afterEach(() => {
  setStudioFrameCaptureRequested(false);
  publishStudioFrameCaptureSession(undefined);
});

describe("studioFrameCaptureDiagnostics", () => {
  const snapshot = (frameId: string): PbrFrameReadbackResult => ({ frameId, resourceId: "present-color",
    width: 1, height: 1, format: "rgba8unorm", bytesPerRow: 4, bytes: new Uint8Array([1, 2, 3, 255]) });

  it("releases readback bytes on close and gathers fresh frames after reopening", () => {
    setStudioFrameCaptureRequested(true);
    const session = createRequestedStudioFrameCaptureSession()!;
    const receive = createStudioFrameReadbackListener(session);
    receive([snapshot("unpublished")]);
    expect(readStudioFrameReadbacks()).toEqual([]);
    publishStudioFrameCaptureSession(session);
    receive([snapshot("before-close")]);
    expect(readStudioFrameReadbacks()).toHaveLength(1);
    setStudioFrameCaptureRequested(false);
    expect(readStudioFrameReadbacks()).toEqual([]);
    receive([snapshot("late-closed")]);
    expect(readStudioFrameReadbacks()).toEqual([]);
    setStudioFrameCaptureRequested(true);
    receive([snapshot("reopened")]);
    expect(readStudioFrameReadbacks()[0]?.results[0]?.frameId).toBe("reopened");
  });

  it("clears replaced owner bytes without accepting its late callbacks or clearing its successor", () => {
    setStudioFrameCaptureRequested(true);
    const oldSession = createRequestedStudioFrameCaptureSession()!;
    const nextSession = createRequestedStudioFrameCaptureSession()!;
    const receiveOld = createStudioFrameReadbackListener(oldSession);
    const receiveNext = createStudioFrameReadbackListener(nextSession);
    publishStudioFrameCaptureSession(oldSession);
    receiveOld([snapshot("old")]);
    publishStudioFrameCaptureSession(nextSession);
    expect(readStudioFrameReadbacks()).toEqual([]);
    receiveOld([snapshot("late-old")]);
    expect(readStudioFrameReadbacks()).toEqual([]);
    receiveNext([snapshot("next")]);
    releaseStudioFrameCaptureSession(oldSession);
    expect(readStudioFrameReadbacks()[0]?.results[0]?.frameId).toBe("next");
    publishStudioFrameCaptureSession(nextSession);
    expect(readStudioFrameReadbacks()).toHaveLength(1);
    releaseStudioFrameCaptureSession(nextSession);
    expect(readStudioFrameReadbacks()).toEqual([]);
    receiveNext([snapshot("late-released")]);
    expect(readStudioFrameReadbacks()).toEqual([]);
  });

  it("keeps only the newest eight current-owner readbacks", () => {
    setStudioFrameCaptureRequested(true);
    const session = createRequestedStudioFrameCaptureSession()!;
    publishStudioFrameCaptureSession(session);
    const receive = createStudioFrameReadbackListener(session);
    for (let frame = 0; frame < 10; frame++) receive([snapshot(`frame-${frame}`)]);
    expect(readStudioFrameReadbacks()).toHaveLength(8);
    expect(readStudioFrameReadbacks()[0]?.results[0]?.frameId).toBe("frame-2");
    expect(readStudioFrameReadbacks()[7]?.results[0]?.frameId).toBe("frame-9");
  });
  it("reads opaque HDR only for the explicit pass-isolation URL option", () => {
    const normal = [{ resourceId: "present-color" }, { resourceId: "linear-depth" }];
    expect(studioFrameReadbackRequests("")).toEqual(normal);
    expect(studioFrameReadbackRequests("?deep-capture-opaque=0")).toEqual(normal);
    expect(studioFrameReadbackRequests("?deep-capture-opaque=1")).toEqual([...normal,
      { resourceId: "opaque-hdr" }, { resourceId: "composited-hdr" }]);
    expect(createRequestedStudioFrameCaptureSession()).toBeUndefined();
  });
  it("skips candidate validation and stops readbacks after two published frames until reopening", () => {
    setStudioFrameCaptureRequested(true);
    const session = createRequestedStudioFrameCaptureSession()!;
    expect(session.beginFrame("candidate", 1)).toBe(false);
    expect(session.records()).toHaveLength(0);
    publishStudioFrameCaptureSession(session);
    for (let i = 0; i < 2; i++) {
      expect(session.beginFrame(`published-${i}`, i + 2)).not.toBe(false);
      session.endFrame(i + 3);
    }
    for (let i = 0; i < 100; i++) expect(session.beginFrame(`idle-${i}`, i + 4)).toBe(false);
    expect(session.records()).toHaveLength(2);
    setStudioFrameCaptureRequested(false);
    setStudioFrameCaptureRequested(true);
    expect(session.beginFrame("reopened", 104)).not.toBe(false);
    session.endFrame(105);
    expect(session.records()).toHaveLength(3);
  });
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
