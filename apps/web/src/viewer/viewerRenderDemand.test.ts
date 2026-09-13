import { describe, expect, it } from "vitest";
import { isCloudCaptureSearch, ViewerRenderDemand } from "./viewerRenderDemand";

describe("ViewerRenderDemand", () => {
  it("renders once, coalesces edits and allows controls to settle before sleeping", () => {
    const demand = new ViewerRenderDemand();
    expect(demand.shouldRender(0, false, true, false)).toBe(true);
    demand.didRender();
    expect(demand.shouldRender(16, false, true, false)).toBe(false);
    demand.invalidate(20); demand.invalidate(25);
    expect(demand.shouldRender(30, false, true, false)).toBe(true);
    demand.didRender();
    expect(demand.shouldRender(140, false, true, false)).toBe(true);
    demand.didRender();
    expect(demand.shouldRender(145, false, true, false)).toBe(false);
  });

  it("keeps animation, video, XR and explicit script sources live without camera movement", () => {
    const demand = new ViewerRenderDemand(); demand.didRender();
    expect(demand.shouldRender(5000, true, true, false)).toBe(true);
    expect(demand.shouldRender(5000, false, false, true)).toBe(true);
    demand.setContinuous("scene-behavior", true, 0); demand.didRender();
    expect(demand.shouldRender(5000, false, true, false)).toBe(true);
    expect(demand.shouldRender(5000, false, false, false)).toBe(false);
    demand.setContinuous("scene-behavior", false, 5001);
    expect(demand.shouldRender(5001, false, true, false)).toBe(true);
    demand.didRender();
    expect(demand.shouldRender(5200, false, true, false)).toBe(false);
  });

  it("keeps cloud capture live in the background and preserves hidden edits for restoration", () => {
    const demand = new ViewerRenderDemand(); demand.didRender();
    demand.invalidate(0);
    expect(demand.shouldRender(300, false, false, false)).toBe(false);
    expect(demand.shouldRender(300, false, true, false)).toBe(true);
    demand.didRender();
    demand.setContinuous("cloud-capture", true, 400); demand.didRender();
    expect(demand.shouldRender(20_000, false, false, false)).toBe(true);
    expect(demand.snapshot().continuousSources).toEqual(["cloud-capture"]);
  });

  it("skips static work for an idle minute yet immediately wakes for resize or external edits", () => {
    const demand = new ViewerRenderDemand(); demand.didRender();
    for (let frame = 1; frame <= 3600; frame += 1) expect(demand.shouldRender(frame * 1000 / 60, false, true, false)).toBe(false);
    demand.invalidate(60_001);
    expect(demand.shouldRender(60_002, false, true, false)).toBe(true);
    expect(demand.snapshot()).toMatchObject({ renderedFrames: 1, skippedFrames: 3600 });
  });

  it.each(["?cloudRender=1", "?project=x&remoteRender=true", "?cloudRender"])("recognizes cloud capture %s", search => {
    expect(isCloudCaptureSearch(search)).toBe(true);
  });
  it.each(["", "?project=cloudRender", "?cloudRender=false", "?remoteRender=0", "?cloudRender=off"])("does not enable capture for %s", search => {
    expect(isCloudCaptureSearch(search)).toBe(false);
  });
});
