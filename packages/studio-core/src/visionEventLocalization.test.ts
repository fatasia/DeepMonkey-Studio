import { describe, expect, it } from "vitest";
import { localizeVisionEvent, type VisionEventLocalizationInput } from "./visionEventLocalization.js";

const calibratedInput: VisionEventLocalizationInput = {
  sceneId: "scene-a",
  detection: { label: "pump", confidence: 0.92, bbox: [0.45, 0.45, 0.1, 0.1] },
  image: { width: 1_000, height: 800 },
  bboxCoordinates: "normalized",
  calibration: {
    cameraPosition: { x: 0, y: 0, z: 0 },
    cameraToWorldRotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    intrinsics: { fx: 800, fy: 800, cx: 500, cy: 400 },
    projectionPlane: { normal: { x: 0, y: 0, z: -1 }, constant: 10 },
    residualP95Pixels: 2,
    verifiedAt: "2026-08-30T00:00:00.000Z",
  },
  boundObjectIds: ["pump-01"],
  anchors: [{ objectId: "pump-01", name: "Pump", position: { x: 0, y: 0, z: 10 }, labels: ["pump"] }],
};

describe("localizeVisionEvent", () => {
  it("uses calibrated ray-plane projection and keeps evidence reviewable", () => {
    const result = localizeVisionEvent(calibratedInput);
    expect(result.method).toBe("calibrated-ray-plane");
    expect(result.position).toEqual({ x: 0, y: 0, z: 10 });
    expect(result.objectCandidates[0]?.objectId).toBe("pump-01");
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.requiresHumanConfirmation).toBe(true);
    expect(result.operationalPolicy).toBe("visualization-evidence-only");
  });

  it("falls back to an explicitly bound anchor without claiming precise location", () => {
    const result = localizeVisionEvent({ ...calibratedInput, calibration: undefined, detection: { label: "pump", confidence: 0.9 } });
    expect(result.method).toBe("bound-object-anchor");
    expect(result.status).toBe("review-required");
    expect(result.position).toEqual({ x: 0, y: 0, z: 10 });
    expect(result.confidence).toBeLessThanOrEqual(0.55);
    expect(result.issues.join(" ")).toContain("不代表缺陷在对象表面的精确位置");
  });

  it("does not invent a position without calibration or a bound anchor", () => {
    const result = localizeVisionEvent({
      sceneId: "scene-a",
      detection: { label: "person", confidence: 0.7 },
      image: { width: 640, height: 480 },
      bboxCoordinates: "pixels",
    });
    expect(result.status).toBe("unlocalized");
    expect(result.position).toBeUndefined();
    expect(result.confidence).toBe(0);
  });

  it("is deterministic and exposes ambiguous object candidates", () => {
    const input = {
      ...calibratedInput,
      boundObjectIds: ["pump-01", "pump-02"],
      anchors: [
        { objectId: "pump-02", name: "Pump", position: { x: 0.1, y: 0, z: 10 }, labels: ["pump"] },
        ...calibratedInput.anchors!,
      ],
    };
    const first = localizeVisionEvent(input);
    const second = localizeVisionEvent(input);
    expect(first.evidenceFingerprint).toBe(second.evidenceFingerprint);
    expect(first.objectCandidates).toHaveLength(2);
    expect(first.issues.join(" ")).toContain("必须由用户确认");
  });

  it("rejects invalid calibration instead of silently degrading", () => {
    expect(() => localizeVisionEvent({
      ...calibratedInput,
      calibration: { ...calibratedInput.calibration!, intrinsics: { fx: 0, fy: 800, cx: 500, cy: 400 } },
    })).toThrow("焦距参数");
  });
});
