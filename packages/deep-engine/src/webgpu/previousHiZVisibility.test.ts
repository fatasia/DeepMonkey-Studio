import { describe, expect, it, vi } from "vitest";
import type { HiZResult } from "./hiZPyramid.js";
import { PreviousHiZVisibility, type PreviousHiZFrameInput } from "./previousHiZVisibility.js";

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

interface FakeTexture extends GPUTexture { readonly destroy: ReturnType<typeof vi.fn> }
function pyramid(revision: number, width = 64, height = 32, reversedZ = false, label = `hiz-${revision}`): HiZResult {
  const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const texture = { label, width, height, depthOrArrayLayers: 1, mipLevelCount, sampleCount: 1,
    dimension: "2d", format: "r32float", usage: 1, destroy: vi.fn() } as unknown as FakeTexture;
  return Object.freeze({ texture, format: "r32float", width, height, mipLevelCount,
    levels: Object.freeze(Array.from({ length: mipLevelCount }, (_, level) => ({ level,
      width: Math.max(1, Math.floor(width / 2 ** level)), height: Math.max(1, Math.floor(height / 2 ** level)),
      view: {} as GPUTextureView }))), sourceRevision: revision, reversedZ,
    reduction: reversedZ ? "min" : "max", updated: true });
}

function frame(frameRevision: number, changes: Partial<PreviousHiZFrameInput> = {}): PreviousHiZFrameInput {
  return { frameRevision, sceneRevision: 3, depthViewProjection: identity,
    stableViewProjection: identity, cameraPosition: [0, 0, 5], viewport: [64, 32],
    reversedZ: false, cameraCut: false, ...changes };
}

function commitFirst(history: PreviousHiZVisibility, texture = pyramid(0)): HiZResult {
  const first = history.beginFrame(frame(0));
  expect(first).toMatchObject({ mode: "direct", reason: "first-frame" });
  history.commitFrame(first, texture);
  return texture;
}

describe("previous submitted Hi-Z visibility", () => {
  it("publishes only committed Hi-Z and supplies its exact producer camera to occlusion", () => {
    const history = new PreviousHiZVisibility(), oldDepth = commitFirst(history);
    const currentDepthMatrix = new Float32Array(identity); currentDepthMatrix[8] = 0.01;
    const next = history.beginFrame(frame(1, { depthViewProjection: currentDepthMatrix }));
    expect(next).toEqual({ mode: "occlusion", frameRevision: 1 });
    expect(history.occlusionView(next)).toMatchObject({ hiz: oldDepth, viewProjection: Array.from(identity),
      cameraPosition: [0, 0, 5], viewport: [64, 32], reversedZ: false });
    const newDepth = pyramid(1); history.commitFrame(next, newDepth);
    const third = history.beginFrame(frame(2, { depthViewProjection: currentDepthMatrix }));
    expect(history.occlusionView(third)?.hiz).toBe(newDepth);
  });

  it.each([
    ["camera-cut", { cameraCut: true }],
    ["viewport-changed", { viewport: [32, 32] as const }],
    ["depth-convention-changed", { reversedZ: true }],
    ["scene-changed", { sceneRevision: 4 }],
    ["camera-changed", { stableViewProjection: new Float32Array([...identity.slice(0, 12), 0.1, 0, 0, 1]) }],
    ["camera-changed", { cameraPosition: [0.1, 0, 5] as const }],
  ] as const)("uses the direct path for %s", (reason, changes) => {
    const history = new PreviousHiZVisibility(); commitFirst(history);
    const plan = history.beginFrame(frame(1, changes));
    expect(plan).toMatchObject({ mode: "direct", reason });
    expect(history.occlusionView(plan)).toBeUndefined();
  });

  it("resumes from the newly submitted camera after a conservative camera-cut frame", () => {
    const history = new PreviousHiZVisibility(); commitFirst(history);
    const moved = new Float32Array(identity); moved[12] = 2;
    const cut = history.beginFrame(frame(1, { cameraCut: true, depthViewProjection: moved,
      stableViewProjection: moved, cameraPosition: [2, 0, 5] }));
    expect(cut).toMatchObject({ mode: "direct", reason: "camera-cut" });
    history.commitFrame(cut, pyramid(1));
    const stable = history.beginFrame(frame(2, { depthViewProjection: moved,
      stableViewProjection: moved, cameraPosition: [2, 0, 5] }));
    expect(stable.mode).toBe("occlusion");
    expect(history.occlusionView(stable)).toMatchObject({ viewProjection: Array.from(moved), cameraPosition: [2, 0, 5] });
  });

  it("keeps history only for cancellation before producer work and fails closed after uncertainty", () => {
    const history = new PreviousHiZVisibility(), oldDepth = commitFirst(history);
    const cancelled = history.beginFrame(frame(1)); history.cancelFrame(cancelled);
    const retry = history.beginFrame(frame(1));
    expect(history.occlusionView(retry)?.hiz).toBe(oldDepth);
    history.failFrame(retry);
    const afterFailure = history.beginFrame(frame(2));
    expect(afterFailure).toMatchObject({ mode: "direct", reason: "first-frame" });
  });

  it("invalidates an active borrowed view before producer replacement or device loss", () => {
    const history = new PreviousHiZVisibility(); commitFirst(history);
    const active = history.beginFrame(frame(1));
    expect(history.occlusionView(active)).toBeDefined();
    history.invalidate();
    expect(history.occlusionView(active)).toBeUndefined();
    history.commitFrame(active, pyramid(1));
    const next = history.beginFrame(frame(2));
    expect(next.mode).toBe("occlusion");
  });

  it("replaces revisions and borrowed textures atomically without destroying either owner resource", () => {
    const history = new PreviousHiZVisibility(), oldDepth = commitFirst(history);
    const resize = history.beginFrame(frame(1, { viewport: [128, 64] }));
    const replacement = pyramid(1, 128, 64); history.commitFrame(resize, replacement);
    const next = history.beginFrame(frame(2, { viewport: [128, 64] }));
    expect(history.occlusionView(next)?.hiz.texture).toBe(replacement.texture);
    history.cancelFrame(next); history.dispose(); history.dispose();
    expect((oldDepth.texture as FakeTexture).destroy).not.toHaveBeenCalled();
    expect((replacement.texture as FakeTexture).destroy).not.toHaveBeenCalled();
  });

  it("rejects stale plans and mismatched producer results without partially publishing", () => {
    const history = new PreviousHiZVisibility(); commitFirst(history);
    expect(() => history.beginFrame(frame(0))).toThrow("advance");
    const plan = history.beginFrame(frame(1));
    expect(() => history.beginFrame(frame(2))).toThrow("already active");
    expect(() => history.commitFrame(plan, pyramid(2))).toThrow("revision");
    history.cancelFrame(plan);
    const retry = history.beginFrame(frame(1));
    expect(history.occlusionView(retry)?.hiz.sourceRevision).toBe(0);
    expect(() => history.commitFrame(retry, pyramid(1, 32, 32))).toThrow("viewport");
    history.failFrame(retry);
    expect(() => history.occlusionView(plan)).toThrow("not active");
  });

  it("copies mutable camera input and validates every frame contract", () => {
    const history = new PreviousHiZVisibility(), depth = new Float32Array(identity), stable = new Float32Array(identity);
    const first = history.beginFrame(frame(0, { depthViewProjection: depth, stableViewProjection: stable }));
    depth[0] = 9; stable[0] = 9; history.commitFrame(first, pyramid(0));
    const next = history.beginFrame(frame(1));
    expect(next.mode).toBe("occlusion"); history.cancelFrame(next);
    expect(() => history.beginFrame(frame(1, { frameRevision: -1 }))).toThrow("revisions");
    expect(() => history.beginFrame(frame(1, { depthViewProjection: new Float32Array(15) }))).toThrow("depth matrix");
    expect(() => history.beginFrame(frame(1, { viewport: [0, 32] }))).toThrow("viewport");
    history.dispose(); expect(() => history.beginFrame(frame(2))).toThrow("disposed");
  });
});
