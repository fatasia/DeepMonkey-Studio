import * as THREE from "three";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { presentViewerFrame } from "./viewerFramePresentation";

function fixture() {
  const calls: string[] = [];
  const listener = vi.fn(() => { calls.push("present"); });
  return { calls, listener, frame: {
    authorBackend: "webgl" as const, presentationBackend: "webgpu" as const,
    xrActive: false, offscreenFrame: false, listeners: new Set([listener]),
    drawAuthor: vi.fn(() => { calls.push("draw"); }),
    updateAuthorMatrices: vi.fn(() => { calls.push("matrices"); }),
  } };
}

describe("single scene presentation renderer", () => {
  it("keeps author updates and subscribers without hidden WebGL or Composer draw", () => {
    const f = fixture(); presentViewerFrame(f.frame);
    expect(f.calls).toEqual(["matrices", "present"]);
    expect(f.frame.drawAuthor).not.toHaveBeenCalled(); expect(f.listener).toHaveBeenCalledOnce();
  });
  it("publishes the latest animated world transform and camera after skipping the draw", () => {
    const f = fixture(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
    const parent = new THREE.Group(), model = new THREE.Object3D(); parent.add(model); scene.add(parent);
    parent.position.x = 3; model.position.y = 2; camera.position.z = 8;
    f.frame.updateAuthorMatrices = vi.fn(() => { scene.updateMatrixWorld(); camera.updateMatrixWorld(); });
    f.frame.listeners = new Set([vi.fn(() => {
      expect(model.matrixWorld.elements.slice(12, 15)).toEqual([3, 2, 0]);
      expect(camera.matrixWorld.elements[14]).toBe(8);
    })]);
    presentViewerFrame(f.frame); expect(f.frame.drawAuthor).not.toHaveBeenCalled();
    expect(f.frame.updateAuthorMatrices).toHaveBeenCalledOnce();
  });
  it.each(["webgl", "webgpu"] as const)("keeps the original %s renderer when it is also the presentation renderer", backend => {
    const f = fixture(); presentViewerFrame({ ...f.frame, authorBackend: backend, presentationBackend: backend });
    expect(f.calls).toEqual(["draw", "present"]);
  });
  it.each([{ xrActive: true }, { offscreenFrame: true }])("preserves XR and offscreen author draw: %j", override => {
    const f = fixture(); presentViewerFrame({ ...f.frame, ...override });
    expect(f.calls).toEqual(["draw", "present"]);
  });
  it("does not suppress rendering when the external renderer has no subscriber", () => {
    const f = fixture(); f.frame.listeners.clear(); presentViewerFrame(f.frame);
    expect(f.calls).toEqual(["draw"]);
  });
  it("resumes author drawing immediately after a subscriber triggers fallback", () => {
    const f = fixture(); presentViewerFrame(f.frame);
    presentViewerFrame({ ...f.frame, presentationBackend: "webgl" });
    expect(f.calls).toEqual(["matrices", "present", "draw", "present"]);
  });
  it("keeps simulation outside the presentation gate and GPU accounting inside author draw", () => {
    const source = readFileSync(new URL("./viewerEngineRuntime.ts", import.meta.url), "utf8");
    const presentation = source.indexOf("presentViewerFrame({");
    for (const update of ["mixer.update(delta)", "this.updateNavigation(delta)", "this.updatePhysics(delta)",
      "this.updateModelRig()", "this.orbit.update()", "this.resize()"])
      expect(source.indexOf(update)).toBeLessThan(presentation);
    const draw = source.indexOf("private drawAuthorScene(");
    for (const operation of ["this.repeatedAssetBatcher.begin(", "this.postProcessing.render(delta)",
      "this.renderer.render(this.scene, this.camera)", "this.gpuFrameTimeMonitor.onFrameRendered()"])
      expect(source.indexOf(operation)).toBeGreaterThan(draw);
  });
  it("wakes demand rendering when presentation switches back to the author canvas", () => {
    const source = readFileSync(new URL("./viewerEngineInteraction.ts", import.meta.url), "utf8");
    const setter = source.slice(source.indexOf("setPresentationRendererBackend("), source.indexOf("/** 保留旧 API"));
    expect(setter).toContain("this.presentationRendererBackend = backend;");
    expect(setter).toContain("this.requestRender();");
  });
});
