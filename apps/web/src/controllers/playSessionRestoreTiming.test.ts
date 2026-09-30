import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createScenePlayModeController } from "../hooks/useScenePlayMode";
import { createPlaySessionRestore } from "./playSessionRestore";
import { beginPlayRestoreTiming, PLAY_RESTORE_MEASURE, type PlayRestoreTimeline } from "./playSessionRestoreTiming";

function clock() {
  let elapsed = 0;
  const timeline = { now: () => elapsed, measure: vi.fn(), clearMeasures: vi.fn() };
  return { timeline, advance: (ms: number) => { elapsed += ms; } };
}
const snapshot = (): SceneSnapshot => ({ schemaVersion: 1, id: "play-scene", projectId: "p", name: "Play",
  camera: { position: { x: 0, y: 2, z: 4 }, target: { x: 0, y: 0, z: 0 } },
  models: [], primitives: [], measurements: [] } as unknown as SceneSnapshot);

describe("production Play restore timing", () => {
  it("uses elapsed segments and replaces only its own immutable receipt", async () => {
    const c = clock(), measure = beginPlayRestoreTiming("scene", c.timeline);
    expect(measure.sync("capture", () => { c.advance(2); return 7; })).toBe(7);
    c.advance(1);
    await measure.async("apply-incremental", async () => { c.advance(8); });
    const receipt = measure.finish("incremental", "passed", false);
    expect(receipt).toMatchObject({ durationMs: 11, stages: { capture: 2, "apply-incremental": 8 } });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.stages)).toBe(true);
    expect(c.timeline.clearMeasures).toHaveBeenCalledWith(PLAY_RESTORE_MEASURE);
    expect(c.timeline.measure).toHaveBeenCalledWith(PLAY_RESTORE_MEASURE, { start: 0, end: 11, detail: receipt });
  });

  it("keeps restoration results when browser measure is unavailable", async () => {
    const c = clock();
    c.timeline.measure.mockImplementation(() => { throw new Error("timeline disabled"); });
    const restore = createPlaySessionRestore(() => ({ engine: () => undefined, project: () => ({}),
      captureLive: snapshot, applyFull: async () => { c.advance(4); }, applyIncremental: async () => undefined }), c.timeline);
    await expect(restore.restore(snapshot())).resolves.toEqual({ path: "full", plan: undefined });
    expect(restore.getLastTiming()).toMatchObject({ status: "passed", durationMs: 4 });
  });

  for (const failure of ["apply-incremental", "verify"] as const) {
    it(`keeps the actual Play session after ${failure}, retries full failures, then restores its original snapshot`, async () => {
      const c = clock(), scene = snapshot();
      let restored = failure !== "verify", failFull = true, physics = { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } };
      const errors: unknown[] = [], seeks: number[] = [], applied: SceneSnapshot[] = [];
      const engine = { getAuthorRendererBackend: () => "webgl", hasRestoredSceneSnapshot: () => restored,
        getPhysicsState: () => physics, setPhysicsState: (next: typeof physics) => { physics = next; },
        playSceneAnimation: vi.fn(), pauseSceneAnimation: vi.fn(), seekSceneAnimation: (t: number) => { seeks.push(t); } };
      const incremental = vi.fn(async (saved: SceneSnapshot) => {
        c.advance(5); applied.push(saved);
        if (failure === "apply-incremental") throw new Error("incremental rejected");
      });
      const full = vi.fn(async (saved: SceneSnapshot) => {
        c.advance(12); applied.push(saved);
        if (failFull) throw new Error("full rejected");
        Object.assign(scene, structuredClone(saved)); restored = true;
      });
      const restore = createPlaySessionRestore(() => ({ engine: () => engine, project: () => ({}),
        captureLive: () => structuredClone(scene), applyFull: full, applyIncremental: incremental }), c.timeline);
      const play = createScenePlayModeController(() => ({ engine, capture: () => scene, flush: vi.fn(),
        applyScene: async saved => { await restore.restore(saved); }, readAnimationPlayhead: () => 2.25,
        reportError: error => { errors.push(error); } }), vi.fn());
      expect(restore.getLastTiming()).toBeUndefined();
      expect(play.enterPlay()).toEqual({ ok: true });
      expect(c.timeline.measure).not.toHaveBeenCalled();
      scene.name = "temporary play edit";
      expect(await play.exitPlay()).toEqual({ ok: false, reason: "restore-failed" });
      const first = restore.getLastTiming();
      expect(first).toMatchObject({ path: "incremental", status: "failed", degraded: true, failedStage: failure });
      expect(play.active).toBe(true); expect(physics.playing).toBe(false); expect(seeks).toEqual([]);
      expect(await play.exitPlay()).toEqual({ ok: false, reason: "restore-failed" });
      expect(restore.getLastTiming()).toMatchObject({ path: "full", status: "failed", failedStage: "apply-full" });
      expect(play.active).toBe(true);
      failFull = false;
      expect(await play.exitPlay()).toEqual({ ok: true });
      expect(play.active).toBe(false); expect(scene.name).toBe("Play"); expect(seeks).toEqual([2.25]);
      expect(incremental).toHaveBeenCalledOnce(); expect(full).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(2); expect(applied.every(saved => saved.name === "Play")).toBe(true);
      expect(new Set(applied).size).toBe(3);
      expect(restore.getLastTiming()).toMatchObject({ path: "full", status: "passed", degraded: true });
      expect(first?.status).toBe("failed"); expect(c.timeline.measure).toHaveBeenCalledTimes(3);
    });
  }

  it("records capture failures without changing the session degradation decision", async () => {
    const c = clock(), error = new Error("snapshot unavailable");
    const restore = createPlaySessionRestore(() => ({ engine: () => ({ getAuthorRendererBackend: () => "webgl", hasRestoredSceneSnapshot: () => true }),
      project: () => ({}), captureLive: () => { c.advance(3); throw error; }, applyFull: vi.fn(), applyIncremental: vi.fn() }), c.timeline as PlayRestoreTimeline);
    await expect(restore.restore(snapshot())).rejects.toBe(error);
    expect(restore.getLastTiming()).toMatchObject({ path: "none", failedStage: "capture", degraded: false, durationMs: 3 });
  });
});
