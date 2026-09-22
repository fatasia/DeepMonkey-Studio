import { describe, expect, it } from "vitest";
import { FrameCaptureSession } from "../r12/frameCapture.js";
import { buildPbrFrameExecutionPlan } from "./pbrFramePlanExecutor.js";
import { PbrFrameCapture, pbrCapturePassInput } from "./pbrFrameCapture.js";
import type { PbrActualPassDescription } from "./pbrFramePlanResources.js";

const PLAN = buildPbrFrameExecutionPlan({ width: 64, height: 32 }, { transparency: false });

function actual(passId: string): PbrActualPassDescription {
  return {
    passId,
    executor: `executor:${passId}`,
    kind: "render",
    reads: ["opaque-hdr"],
    writes: ["surface"],
    claims: [],
  };
}

describe("PbrFrameCapture", () => {
  it("requires an explicit host clock outside the renderer", () => {
    expect(() => new PbrFrameCapture({ session: new FrameCaptureSession() })).toThrow("host-supplied monotonic clock");
  });
  it("rejects external provenance on the built-in renderer", () => {
    const session = new FrameCaptureSession();
    expect(() => new PbrFrameCapture({ session, sourceMapRefsByPass: new Map() }, { builtinRenderer: true })).toThrow("rejects external");
    expect(() => new PbrFrameCapture({ session, shaderPackage: { passes: [] }, shaderPassBindings: [] }, { builtinRenderer: true })).toThrow("rejects external");
  });
  it("keeps executed present refs queryable and rejects external conflicts", () => {
    const session = new FrameCaptureSession(), refs = [{ moduleId: "builtin.output", stage: "fragment" as const,
      nodeId: "wgsl.entrypoint.fragmentMain", generatedLine: 1 }];
    const capture = new PbrFrameCapture({ session, now: () => 10 }, { builtinRenderer: true });
    capture.begin("executed", PLAN);
    capture.recordPasses([actual("present")], new Set(["present"]), refs);
    capture.end();
    expect(session.findBySourceMap({ nodeId: "wgsl.entrypoint.fragmentMain" })).toHaveLength(1);
    const external = new PbrFrameCapture({ session, now: () => 10, sourceMapRefsByPass: new Map([["present", refs]]) });
    expect(() => external.recordPasses([actual("present")], undefined, refs)).toThrow("conflicts");
  });
  it("preserves an existing frame when a new begin is rejected", () => {
    const session = new FrameCaptureSession();
    const capture = new PbrFrameCapture({ session, now: () => 10 });
    session.beginFrame("external", 1);
    expect(() => capture.begin("frame-1", PLAN)).toThrow("still open");
    expect(session.activeFrameId).toBe("external");
    expect(session.endFrame(11).frameId).toBe("external");
  });

  it("cancels its own frame if the initial marker fails and permits retry", () => {
    const session = new FrameCaptureSession();
    const times = [10, 9, 20, 21, 22];
    const capture = new PbrFrameCapture({ session, now: () => times.shift()! });
    expect(() => capture.begin("frame-1", PLAN)).toThrow("outside the frame bounds");
    expect(session.activeFrameId).toBeUndefined();
    expect(session.records()).toEqual([]);
    capture.begin("frame-1", PLAN);
    expect(capture.end().frameId).toBe("frame-1");
  });

  it("allows the renderer to discard a rejected record and retry the frame", () => {
    const session = new FrameCaptureSession();
    let timestamp = 1;
    const capture = new PbrFrameCapture({ session, now: () => timestamp++ });
    capture.begin("frame-1", PLAN);
    capture.recordPasses([{ ...actual("opaque"), writes: ["bad id"] }]);
    expect(() => capture.end()).toThrow("bounded identifier");
    capture.cancel();
    expect(session.records()).toEqual([]);
    capture.begin("frame-1", PLAN);
    expect(capture.end().frameId).toBe("frame-1");
  });

  it("records the compiled plan hash, selected executed passes, timeline, and source-map refs", () => {
    const session = new FrameCaptureSession();
    let timestamp = 100;
    const capture = new PbrFrameCapture({
      session,
      now: () => timestamp++,
      sourceMapRefsByPass: new Map([["opaque", [{
        moduleId: "pbr/main",
        stage: "fragment",
        nodeId: "base-color",
        generatedLine: 17,
      }]]]),
    });

    capture.begin("frame-1", PLAN);
    capture.recordPasses([actual("opaque"), actual("not-executed")], new Set(["opaque"]));
    capture.mark("submit", "queue submit");
    const record = capture.end();

    expect(record.planHash).toBe(PLAN.planHash);
    expect(record.passes).toHaveLength(1);
    expect(record.passes[0]).toMatchObject({
      passId: "opaque",
      executor: "executor:opaque",
      sourceMapRefs: [{ moduleId: "pbr/main", nodeId: "base-color", generatedLine: 17 }],
    });
    expect(record.markers.map(marker => marker.markerId)).toEqual(["encode-start", "submit"]);
    expect(session.activeFrameId).toBeUndefined();
  });

  it("maps executor, resources, and source-map refs into a pass input", () => {
    const refs = [{ moduleId: "pbr/main", stage: "vertex" as const, nodeId: "position", generatedLine: 9 }];
    const input = pbrCapturePassInput(actual("opaque"), new Map([["opaque", refs]]));
    expect(input).toMatchObject({ passId: "opaque", executor: "executor:opaque", sourceMapRefs: refs });
    expect(input.reads).toEqual(["opaque-hdr"]);
    expect(input.writes).toEqual(["surface"]);
  });

  it("cancels an encode failure without retaining a partial frame", () => {
    const session = new FrameCaptureSession();
    let timestamp = 200;
    const capture = new PbrFrameCapture({ session, now: () => timestamp++ });

    capture.begin("frame-1", PLAN);
    capture.recordPasses([actual("opaque")]);
    capture.cancel();

    expect(session.activeFrameId).toBeUndefined();
    expect(session.records()).toEqual([]);
    capture.begin("frame-2", PLAN);
    expect(capture.end().frameId).toBe("frame-2");
  });
});
