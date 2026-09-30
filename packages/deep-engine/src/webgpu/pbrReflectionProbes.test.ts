import { describe, expect, it, vi } from "vitest";
import { PbrEnvironmentState } from "./pbrEnvironmentState.js";
import { attachPbrReflectionProbes, packPbrReflectionProbes, pbrReflectionProbeViews } from "./pbrReflectionProbes.js";
import { packReflectionProbeRecord } from "../lighting/reflectionProbeParallax.js";
import type { StudioEnvironment } from "./studioEnvironment.js";

const box = { center: [0, 1, 0] as const, halfExtents: [2, 3, 4] as const, blendDistance: 1, influenceRadius: 2 };
function environment() { return { specular: {}, diffuse: {}, brdf: {}, sampler: {}, dispose: vi.fn() } as unknown as StudioEnvironment & { dispose: ReturnType<typeof vi.fn> }; }

describe("production reflection probe records and ownership", () => {
  it("aliases the existing cube for no probes, creates no fallback owner, and zeroes influence", () => {
    const base = environment(); expect(attachPbrReflectionProbes(base, [])).toBe(base);
    expect(pbrReflectionProbeViews(base)).toEqual([base.specular, base.specular]);
    const records = packPbrReflectionProbes(); expect(records.byteLength).toBe(128);
    expect(records[7]).toBe(0); expect(records[23]).toBe(0); expect(base.dispose).not.toHaveBeenCalled();
  });
  it("preserves canonical records, freezes author boxes, and deduplicates shared owners", () => {
    const base = environment(), shared = environment(), mutable = { ...box, center: [...box.center] };
    const probes = [{ box: mutable, environment: shared }, { box, environment: shared }];
    const combined = attachPbrReflectionProbes(base, probes);
    const records = packPbrReflectionProbes(combined.reflectionProbes);
    expect(records.slice(0, 16)).toEqual(new Float32Array(packReflectionProbeRecord(box)));
    mutable.center[0] = 999;
    expect(combined.reflectionProbes?.[0]?.box.center[0]).toBe(0);
    expect(pbrReflectionProbeViews(combined)).toEqual([shared.specular, shared.specular]);
    combined.dispose(); combined.dispose(); expect(base.dispose).toHaveBeenCalledOnce(); expect(shared.dispose).toHaveBeenCalledOnce();
  });
  it("rejects over-budget/invalid records before assuming resource ownership", () => {
    const base = environment(), probe = { box, environment: environment() };
    expect(() => attachPbrReflectionProbes(base, [probe, probe, probe])).toThrow("two");
    expect(() => attachPbrReflectionProbes(base, [{ ...probe, box: { ...box, halfExtents: [0, 1, 1] } }])).toThrow();
    expect(base.dispose).not.toHaveBeenCalled(); expect(probe.environment.dispose).not.toHaveBeenCalled();
  });
  it("retains the old owner until an effective frame commits, and cancels unpublished candidates", async () => {
    const old = environment(), base = environment(), probe = environment();
    const candidate = attachPbrReflectionProbes(base, [{ box, environment: probe }]);
    const state = new PbrEnvironmentState(old);
    const abort = new AbortController(); await state.stage(async () => candidate, abort.signal);
    abort.abort(); expect(base.dispose).toHaveBeenCalledOnce(); expect(probe.dispose).toHaveBeenCalledOnce();
    expect(state.current).toBe(old); expect(old.dispose).not.toHaveBeenCalled();
    const replacement = environment(); await state.stage(async () => replacement);
    state.beginFrame(); expect(old.dispose).not.toHaveBeenCalled();
    state.runFrame(() => ({ effective: true }), vi.fn()); expect(old.dispose).toHaveBeenCalledOnce();
    state.dispose(); expect(replacement.dispose).toHaveBeenCalledOnce();
  });
  it("rolls back a failed candidate frame and tries every owned cleanup even if one fails", async () => {
    const old = environment(), base = environment(), probe = environment();
    const candidate = attachPbrReflectionProbes(base, [{ box, environment: probe }]);
    const state = new PbrEnvironmentState(old); await state.stage(async () => candidate); state.beginFrame();
    expect(() => state.runFrame(() => { throw new Error("frame encoding failed"); }, vi.fn())).toThrow("frame encoding failed");
    expect(state.current).toBe(old); expect(old.dispose).not.toHaveBeenCalled(); expect(probe.dispose).toHaveBeenCalledOnce();
    base.dispose.mockImplementation(() => { throw new Error("base cleanup failed"); });
    const second = environment(), combined = attachPbrReflectionProbes(base, [{ box, environment: second }]);
    expect(() => combined.dispose()).toThrow("cleanup"); expect(second.dispose).toHaveBeenCalledOnce();
    combined.dispose(); expect(second.dispose).toHaveBeenCalledOnce(); state.dispose();
  });
});
