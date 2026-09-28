import { describe, expect, it } from "vitest";
import { LocalShadowCache, lightInfluencesOccluder } from "./localShadowCacheInvalidation.js";
import { DEFAULT_SHADOW_PAGE_TILE, ShadowPageTable, buildShadowPageRequests } from "./shadowPages.js";

const light = (key: string, overrides: Partial<Parameters<typeof makeLight>[0]> = {}) => makeLight({ key, ...overrides });
function makeLight(state: { key: string; position?: readonly [number, number, number]; range?: number;
  intensity?: number; castShadow?: boolean; direction?: readonly [number, number, number] }) {
  return {
    key: state.key,
    position: state.position ?? ([0, 0, -5] as const),
    ...(state.direction ? { direction: state.direction } : {}),
    range: state.range ?? 4,
    intensity: state.intensity ?? 1,
    castShadow: state.castShadow ?? true,
  };
}
const occluder = (id: string, min: readonly [number, number, number], max: readonly [number, number, number]) =>
  ({ id, min, max });

describe("local shadow cache invalidation semantics", () => {
  it("plans zero updates for a frozen scene across many frames", () => {
    const cache = new LocalShadowCache();
    const frame = (index: number) => ({ frame: index,
      lights: [light("a", { position: [1, 2, -3] as const }), light("b", { position: [0, 0, -8] as const, range: 6 })],
      occluders: [occluder("wall", [-10, -1, -10], [10, 1, -6])] });
    const first = cache.plan(frame(0));
    expect(first.update).toEqual(["a", "b"]);
    expect(first.reuse).toEqual([]);
    for (const index of [1, 2, 50]) {
      const plan = cache.plan(frame(index));
      expect(plan.update).toEqual([]);
      expect(plan.reuse).toEqual(["a", "b"]);
      expect(plan.evict).toEqual([]);
      expect(plan.stats).toMatchObject({ lightsUpdated: 0, lightsReused: 2, lightsEvicted: 0, occludersChanged: 0 });
    }
  });

  it("invalidates only the moving light and keeps siblings cached", () => {
    const cache = new LocalShadowCache();
    const base = { lights: [light("mover", { position: [0, 0, -5] as const }), light("still", { position: [20, 0, -5] as const })], occluders: [] };
    cache.plan({ frame: 0, ...base });
    const moved = cache.plan({ frame: 1, lights: [
      light("mover", { position: [0.5, 0, -5] as const }), light("still", { position: [20, 0, -5] as const })], occluders: [] });
    expect(moved.update).toEqual(["mover"]);
    expect(moved.reuse).toEqual(["still"]);
  });

  it("invalidates exactly the lights a moved occluder influences", () => {
    const cache = new LocalShadowCache();
    const lights = [
      light("inside", { position: [0, 0, -5] as const, range: 4 }),
      light("far", { position: [50, 0, -5] as const, range: 4 }),
      light("edge", { position: [7, 0, -5] as const, range: 3 }),
    ];
    const occluders = [occluder("crate", [2, -1, -7], [4, 1, -4])];
    cache.plan({ frame: 0, lights, occluders });
    const moved = cache.plan({ frame: 1, lights, occluders: [occluder("crate", [5, -1, -7], [6, 1, -4])] });
    // New bounds touch "edge" (closest point 2 <= 3); old bounds touched "inside" (2 <= 4),
    // so both invalidate — moving in or out must never leave a stale shadow. "far" untouched.
    expect(moved.update).toEqual(["edge", "inside"]);
    expect(moved.reuse).toEqual(["far"]);
    expect(moved.stats.occludersChanged).toBe(1);
  });

  it("invalidates lights when an occluder is added or removed so no stale shadow remains", () => {
    const cache = new LocalShadowCache();
    const lights = [light("victim", { position: [0, 0, -5] as const, range: 6 }), light("clear", { position: [40, 0, -5] as const })];
    cache.plan({ frame: 0, lights, occluders: [] });
    const added = cache.plan({ frame: 1, lights, occluders: [occluder("pillar", [1, -2, -6], [2, 2, -4])] });
    expect(added.update).toEqual(["victim"]);
    expect(added.reuse).toEqual(["clear"]);
    const removed = cache.plan({ frame: 2, lights, occluders: [] });
    expect(removed.update).toEqual(["victim"]);
    expect(removed.reuse).toEqual(["clear"]);
  });

  it("evicts removed lights and never reports them again", () => {
    const cache = new LocalShadowCache();
    const withBoth = { frame: 0, lights: [light("gone", { position: [0, 0, -5] as const }), light("kept", { position: [9, 0, -5] as const })], occluders: [] };
    cache.plan(withBoth);
    const after = cache.plan({ frame: 1, lights: [light("kept", { position: [9, 0, -5] as const })], occluders: [] });
    expect(after.evict).toEqual(["gone"]);
    expect(after.reuse).toEqual(["kept"]);
    expect(cache.cachedLightCount).toBe(1);
    const stable = cache.plan({ frame: 2, lights: [light("kept", { position: [9, 0, -5] as const })], occluders: [] });
    expect(stable.evict).toEqual([]);
    expect(stable.update).toEqual([]);
  });

  it("treats castShadow=false lights as no-shadow-work and honors direction and configEpoch signatures", () => {
    const cache = new LocalShadowCache();
    const disabled = light("off", { castShadow: false });
    cache.plan({ frame: 0, lights: [disabled], occluders: [] });
    expect(cache.plan({ frame: 1, lights: [disabled], occluders: [] }).reuse).toEqual(["off"]);
    const spot = light("s", { direction: [0, 0, -1] });
    cache.plan({ frame: 2, lights: [disabled, spot], occluders: [] });
    const rotated = cache.plan({ frame: 3, lights: [disabled, light("s", { direction: [0.1, 0, -1] })], occluders: [] });
    expect(rotated.update).toEqual(["s"]);
    expect(cache.cachedLightCount).toBe(1);
    const retuned = cache.plan({ frame: 4, lights: [disabled, light("s", { direction: [0.1, 0, -1] })], occluders: [] });
    expect(retuned.update).toEqual([]);
  });

  it("is camera-independent by construction: inputs carry no camera", () => {
    const cache = new LocalShadowCache();
    const frame = { lights: [light("a")], occluders: [] };
    cache.plan({ frame: 0, ...frame });
    // Any camera motion between these calls is invisible to the strategy by API shape.
    expect(cache.plan({ frame: 1, ...frame }).update).toEqual([]);
  });

  it("rejects duplicate keys, malformed geometry and invalid frames", () => {
    const cache = new LocalShadowCache();
    expect(() => cache.plan({ frame: 0, lights: [light("a"), light("a")], occluders: [] })).toThrow("Duplicate light key");
    expect(() => cache.plan({ frame: 0, lights: [], occluders: [occluder("x", [0, 0, 0], [1, 1])] })).toThrow("3-component");
    expect(() => cache.plan({ frame: 0, lights: [light("a", { range: -1 })], occluders: [] })).toThrow("range");
    expect(() => cache.plan({ frame: -1, lights: [], occluders: [] })).toThrow("Frame");
  });
});

describe("invalidation drives shadow page residency", () => {
  it("only changed lights produce page requests; frozen scene admits nothing", () => {
    const cache = new LocalShadowCache();
    const table = new ShadowPageTable(DEFAULT_SHADOW_PAGE_TILE, { maxBytes: 1 << 30 });
    const frameLights = (moverX: number) => [
      light("mover", { position: [moverX, 0, -5] as const }),
      light("still", { position: [30, 0, -5] as const }),
    ];
    const toRequests = (keys: readonly string[]) => buildShadowPageRequests(
      keys.map(key => ({ key, kind: "spot" as const, importance: key === "mover" ? 5 : 3, mipLevels: 1 })));
    const consumed = () => ["mover", "still"]; // every shadowed light the frame still samples

    const first = cache.plan({ frame: 0, lights: frameLights(0), occluders: [] });
    const firstPlan = table.plan(toRequests(consumed()), 0);
    expect(firstPlan.stats.admittedCount).toBe(2);

    const frozen = cache.plan({ frame: 1, lights: frameLights(0), occluders: [] });
    expect(frozen.update).toEqual([]);
    const frozenPlan = table.plan(toRequests(consumed()), 1);
    expect(frozenPlan.admitted).toHaveLength(0);
    expect(frozenPlan.evicted).toHaveLength(0);
    expect(frozenPlan.resident).toHaveLength(2);

    const moved = cache.plan({ frame: 2, lights: frameLights(0.5), occluders: [] });
    const movedPlan = table.plan(toRequests(consumed()), 2);
    expect(moved.update).toEqual(["mover"]);
    expect(movedPlan.admitted).toHaveLength(0);
    expect(movedPlan.evicted).toHaveLength(0);
    expect(movedPlan.resident).toHaveLength(2);
  });
});

describe("lightInfluencesOccluder", () => {
  it("uses closest-point distance and respects castShadow and zero range", () => {
    const base = light("a", { position: [0, 0, -5] as const, range: 4 });
    expect(lightInfluencesOccluder(base, occluder("n", [1, -1, -6], [2, 1, -4]))).toBe(true);
    expect(lightInfluencesOccluder(base, occluder("f", [5, -1, -6], [6, 1, -4]))).toBe(false);
    expect(lightInfluencesOccluder(light("b", { range: 0 }), occluder("n", [0, -1, -6], [1, 1, -4]))).toBe(false);
    expect(lightInfluencesOccluder(light("c", { castShadow: false }), occluder("n", [0, -1, -6], [1, 1, -4]))).toBe(false);
  });
});
