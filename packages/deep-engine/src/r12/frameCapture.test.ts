import { describe, expect, it } from "vitest";
import {
  FrameCaptureSession,
  type FrameCaptureSourceMapRef,
  type PassCaptureInput,
} from "./frameCapture.js";

function pass(passId: string, sourceMapRefs: readonly FrameCaptureSourceMapRef[] = []): PassCaptureInput {
  return {
    passId,
    kind: "render",
    reads: ["scene"],
    writes: ["color"],
    sourceMapRefs,
  };
}

function sourceMap(stage: FrameCaptureSourceMapRef["stage"], nodeId: string, generatedLine: number): FrameCaptureSourceMapRef {
  return { moduleId: "materials/main", stage, nodeId, generatedLine };
}

describe("FrameCaptureSession", () => {
  it("records and normalizes a frame with a pass and timeline marker", () => {
    const session = new FrameCaptureSession();
    session.beginFrame("frame-1", 10, "plan-001");
    session.recordPass({
      ...pass("geometry"),
      execution: { kind: "draw", vertexCount: 3, instanceCount: 1 },
      durationMs: 1.5,
    });
    session.markTimeline({ markerId: "submit", label: "submit", timestampMs: 11 });

    const record = session.endFrame(20);
    expect(record).toMatchObject({
      schema: "deep-engine.frame-capture",
      schemaVersion: 1,
      frameId: "frame-1",
      startedAtMs: 10,
      endedAtMs: 20,
      planHash: "plan-001",
      markers: [{ frameId: "frame-1", markerId: "submit", timestampMs: 11 }],
    });
    expect(record.passes[0]?.execution).toEqual({ kind: "draw", vertexCount: 3, instanceCount: 1 });
    expect(record.passes[0]?.durationMs).toBe(1.5);
    expect(session.records()).toEqual([record]);
  });

  it("rejects recording operations when no frame is open", () => {
    const session = new FrameCaptureSession();
    expect(() => session.recordPass(pass("orphan"))).toThrow("recordPass requires an open frame");
    expect(() => session.markTimeline({ markerId: "orphan", label: "orphan", timestampMs: 0 }))
      .toThrow("markTimeline requires an open frame");
    expect(() => session.endFrame(0)).toThrow("endFrame requires an open frame");
  });

  it("rejects duplicate pass ids in the active frame", () => {
    const session = new FrameCaptureSession();
    session.beginFrame("frame-1", 0);
    session.recordPass(pass("geometry"));

    expect(() => session.recordPass(pass("geometry"))).toThrow("duplicate pass geometry");
    expect(session.endFrame(1).passes).toHaveLength(1);
  });

  it("returns frames that overlap a timeline range and only markers inside it", () => {
    const session = new FrameCaptureSession();
    session.beginFrame("frame-1", 0);
    session.markTimeline({ markerId: "early", label: "early", timestampMs: 2 });
    session.endFrame(10);
    session.beginFrame("frame-2", 20);
    session.markTimeline({ markerId: "late", label: "late", timestampMs: 25 });
    session.endFrame(30);

    expect(session.queryTimelineRange(5, 25)).toMatchObject({
      frames: [{ frameId: "frame-1" }, { frameId: "frame-2" }],
      markers: [{ markerId: "late", frameId: "frame-2", timestampMs: 25 }],
    });
    expect(session.queryTimelineRange(11, 19)).toEqual({ frames: [], markers: [] });
  });

  it("finds source-map matches by the requested fields", () => {
    const session = new FrameCaptureSession();
    session.beginFrame("frame-1", 0);
    session.recordPass(pass("geometry", [
      sourceMap("vertex", "node-position", 12),
      sourceMap("fragment", "node-color", 42),
    ]));
    session.endFrame(1);

    expect(session.findBySourceMap({ moduleId: "materials/main", stage: "vertex" })).toEqual([{
      frameId: "frame-1",
      passId: "geometry",
      sourceMap: sourceMap("vertex", "node-position", 12),
    }]);
    expect(() => session.findBySourceMap({})).toThrow("source-map query must specify a filter");
  });

  it("enforces configured pass, marker, and retained-frame budgets", () => {
    const session = new FrameCaptureSession({ budget: {
      maxFrames: 1,
      maxPassesPerFrame: 1,
      maxMarkersPerFrame: 1,
    } });
    session.beginFrame("frame-1", 0);
    session.recordPass(pass("geometry"));
    expect(() => session.recordPass(pass("lighting"))).toThrow("pass capacity reached");
    session.markTimeline({ markerId: "submit", label: "submit", timestampMs: 0 });
    expect(() => session.markTimeline({ markerId: "present", label: "present", timestampMs: 0 }))
      .toThrow("marker capacity reached");
    session.endFrame(1);

    session.beginFrame("frame-2", 2);
    session.endFrame(3);
    expect(session.records().map(frame => frame.frameId)).toEqual(["frame-2"]);
    expect(session.getFrame("frame-1")).toBeUndefined();
  });

  it("rejects illegal timestamps without losing the open frame", () => {
    const session = new FrameCaptureSession();
    expect(() => session.beginFrame("bad", Number.NaN)).toThrow("startedAtMs must be finite");
    session.beginFrame("frame-1", 10);

    expect(() => session.endFrame(9)).toThrow("endedAtMs must be >= startedAtMs");
    expect(() => session.endFrame(Number.POSITIVE_INFINITY)).toThrow("endedAtMs must be finite");
    expect(session.endFrame(10).endedAtMs).toBe(10);
  });

  it("does not allow a second frame while the current frame is unclosed", () => {
    const session = new FrameCaptureSession();
    session.beginFrame("frame-1", 0);

    expect(() => session.beginFrame("frame-2", 1)).toThrow("frame frame-1 is still open");
    expect(session.records()).toEqual([]);
    expect(session.endFrame(2).frameId).toBe("frame-1");
  });

  it("cancels an in-flight frame without retaining partial passes", () => {
    const session = new FrameCaptureSession();
    session.beginFrame("frame-1", 0, "plan-001");
    session.recordPass(pass("geometry"));
    expect(session.activeFrameId).toBe("frame-1");
    expect(session.cancelFrame()).toBe("frame-1");
    expect(session.activeFrameId).toBeUndefined();
    expect(session.records()).toEqual([]);
    session.beginFrame("frame-2", 1, "plan-002");
    expect(session.endFrame(2).planHash).toBe("plan-002");
  });
});
