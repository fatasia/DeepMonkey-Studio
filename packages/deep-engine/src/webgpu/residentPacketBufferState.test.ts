import { describe, expect, it, vi } from "vitest";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import { ResidentPacketBufferState } from "./residentPacketBufferState.js";

vi.mock("./residentPacketBufferStaging.js", () => ({
  stageResidentPacketBuffers: vi.fn((_context, projection) => ({
    geometries: new Map(), batches: new Map(), createdBuffers: [], acquiredMaterials: [],
    geometryBounds: new Map(), projection, changed: true, settled: false,
  })),
  commitResidentPacketBufferStage: vi.fn((_context, staged) => {
    staged.settled = true;
    return { geometries: staged.geometries, geometryBounds: staged.geometryBounds,
      batches: staged.batches,
      projection: staged.projection, changed: staged.changed };
  }),
  discardResidentPacketBufferStage: vi.fn((_context, staged) => {
    if (staged.settled) return;
    staged.settled = true; staged.projection.release();
  }),
}));

const context = {} as never;
function validationContext() {
  const checks: Array<(error: GPUError | null) => void> = [];
  const device = { pushErrorScope: vi.fn(), popErrorScope: vi.fn(() =>
    new Promise<GPUError | null>(resolve => checks.push(resolve))) };
  return { context: { session: { state: "ready", device } } as never, checks };
}
function projection(): ResidentPacketProjection {
  let released = false;
  return {
    batches: [], get released() { return released; },
    geometry: () => undefined, geometrySource: () => undefined,
    texture: () => undefined, textureSource: () => undefined,
    release: vi.fn(() => { released = true; }),
  };
}

describe("ResidentPacketBufferState", () => {
  it("publishes the exact generation while preserving the previous active owner", () => {
    const state = new ResidentPacketBufferState(), first = projection(), second = projection();
    expect(state.stage(context, first, 1)).toBe(true);
    const initial = state.publish(context, 1)!;
    expect(initial.current.projection).toBe(first);
    expect(initial.previous).toBeUndefined();
    state.stage(context, second, 2);
    const replacement = state.publish(context, 2)!;
    expect(replacement.current.projection).toBe(second);
    expect(replacement.previous?.projection).toBe(first);
    expect(first.released).toBe(false);
  });

  it("cancels a pending owner once and releases its projection", () => {
    const state = new ResidentPacketBufferState(), value = projection();
    state.stage(context, value, 3);
    state.cancel(context); state.cancel(context);
    expect(value.release).toHaveBeenCalledOnce();
    expect(state.pending).toBe(false);
    expect(state.publish(context, 3)).toBeUndefined();
  });

  it("fails closed on a stale generation and leaves the active publication unchanged", () => {
    const state = new ResidentPacketBufferState(), active = projection(), stale = projection();
    state.stage(context, active, 1); state.publish(context, 1);
    state.stage(context, stale, 2);
    expect(() => state.publish(context, 3)).toThrow("superseded");
    expect(stale.release).toHaveBeenCalledOnce();
    expect(state.active?.projection).toBe(active);
  });

  it("detaches active ownership without releasing the projection", () => {
    const state = new ResidentPacketBufferState(), value = projection();
    state.stage(context, value, 1); state.publish(context, 1);
    expect(state.detachActive()?.projection).toBe(value);
    expect(state.detachActive()).toBeUndefined();
    expect(value.released).toBe(false);
  });

  it("keeps a validated candidate private until every GPU scope succeeds", async () => {
    const state = new ResidentPacketBufferState(), f = validationContext(), value = projection();
    const result = state.stageValidated(f.context, value, 7);
    expect(state.pending).toBe(true);
    expect(f.checks).toHaveLength(3);
    f.checks.forEach(resolve => resolve(null));
    await expect(result).resolves.toBe(true);
    expect(state.publish(f.context, 7)?.current.projection).toBe(value);
  });

  it("releases a candidate rejected by GPU validation", async () => {
    const state = new ResidentPacketBufferState(), f = validationContext(), value = projection();
    const result = state.stageValidated(f.context, value, 4);
    f.checks[0]!({ message: "allocation rejected" } as GPUError);
    f.checks[1]!(null); f.checks[2]!(null);
    await expect(result).rejects.toThrow("GPU resident packet preparation failed: allocation rejected");
    expect(value.release).toHaveBeenCalledOnce();
    expect(state.pending).toBe(false);
  });

  it("rejects immediately when a validated candidate is superseded", async () => {
    const state = new ResidentPacketBufferState(), f = validationContext(), value = projection();
    const result = state.stageValidated(f.context, value, 9);
    state.cancel(f.context, 9);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(value.release).toHaveBeenCalledOnce();
  });
});
