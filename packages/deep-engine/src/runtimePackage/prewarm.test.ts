import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RenderPacket } from "../renderPacketTypes.js";
import { hashCanonicalShaderPackage } from "../shaderPackage/hash.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/types.js";
import { buildDeepRuntimePackage } from "./builder.js";
import { runtimePackageSha256 } from "./hash.js";
import { RuntimePackagePrewarmExecutor } from "./prewarmExecutor.js";
import { buildRuntimePackagePrewarmPlan } from "./prewarmPlan.js";
import type { RuntimePackagePrewarmAdapter, RuntimePackagePrewarmCandidate,
  RuntimePackagePrewarmPlan } from "./prewarmTypes.js";

const nativeRoot = new URL("../../../deep-engine-native/", import.meta.url);
const shader = JSON.parse(readFileSync(new URL("tests/fixtures/deep_shader_package_v2.json", nativeRoot), "utf8")) as DeepShaderPackageV2;

function runtime(version = "1.0.0", x = 0, shaders: readonly DeepShaderPackageV2[] = [shader]) {
  const packet: RenderPacket = {
    geometries: [{ id: "triangle", revision: 1,
      vertices: new Float32Array([x - 1, -1, 0, 0, 0, 1, x + 1, -1, 0, 0, 0, 1, x, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "surface", baseColor: [0.5, 0.5, 0.5], metallic: 0.2, roughness: 0.7 }],
    instances: [{ id: "subject", geometry: "triangle", material: "surface",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  };
  return buildDeepRuntimePackage({ packageId: "deep.runtime.prewarm", packageVersion: version,
    renderPacket: { id: "scene.main", revision: 1, value: packet },
    shaderPackages: shaders.map(value => ({ revision: 1, value })) });
}
function shaderAlias(packageId: string): DeepShaderPackageV2 {
  const value = JSON.parse(JSON.stringify(shader)) as DeepShaderPackageV2;
  Object.assign(value, { packageId });
  const { packageCacheKey: _ignored, ...core } = value;
  Object.assign(value, { packageCacheKey: hashCanonicalShaderPackage(core) });
  return value;
}

type Loaded = { readonly key: string };
type Prepared = { readonly key: string };
function immediate(overrides: Partial<RuntimePackagePrewarmAdapter<Loaded, Prepared>> = {}) {
  const loads: string[] = [], prepares: string[] = [], commits: string[][] = [], releases: string[] = [];
  const adapter: RuntimePackagePrewarmAdapter<Loaded, Prepared> = {
    async load(item) { loads.push(item.cacheKey); return { key: item.cacheKey }; },
    async prepare(item) { prepares.push(item.cacheKey); return { key: item.cacheKey }; },
    commit(_plan, candidates) { commits.push(candidates.map(candidate => candidate.item.cacheKey)); },
    release(item) { releases.push(item.cacheKey); },
    ...overrides,
  };
  return { adapter, loads, prepares, commits, releases };
}

describe("runtime package prewarm", () => {
  it("publishes a deterministic resource, bake and shader-pipeline plan", () => {
    const first = buildRuntimePackagePrewarmPlan(runtime()), second = buildRuntimePackagePrewarmPlan(runtime());
    expect(second).toEqual(first);
    expect(first.items.map(item => item.type)).toEqual([
      "resource", "resource", "resource", ...shader.passes.map(() => "shader-pipeline"),
    ]);
    expect(first.items.map((item, order) => item.order === order).every(Boolean)).toBe(true);
    const render = first.items.find(item => item.type === "resource" && item.resourceKind === "render-packet");
    expect(render?.bake).toMatchObject({ schemaVersion: 1, quality: "balanced",
      geometryPlans: [{ id: "triangle", triangleCount: 1, meshletCount: 1 }] });
    expect(first.budget).toMatchObject({ plannedItems: first.items.length, withinLimits: true });
    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(Object.isFrozen(first.items)).toBe(true);
  });

  it("fails closed for invalid entrypoints and explicit plan budgets", () => {
    const broken = JSON.parse(JSON.stringify(runtime()));
    broken.entrypoints.renderPacket = "missing";
    broken.packageHash.value = runtimePackageSha256(broken);
    expect(() => buildRuntimePackagePrewarmPlan(broken)).toThrow(/Entrypoint missing/);
    expect(() => buildRuntimePackagePrewarmPlan(runtime(), { maxItems: 1 })).toThrow(/item budget/);
    expect(() => buildRuntimePackagePrewarmPlan(runtime(), { maxEstimatedBytes: 1 })).toThrow(/byte budget/);
  });

  it("commits once, performs zero work for the same hash and reuses equal content hashes", async () => {
    const fixture = immediate(), executor = new RuntimePackagePrewarmExecutor(fixture.adapter);
    const first = await executor.publish(runtime(), { concurrency: 3 });
    expect(first).toMatchObject({ status: "committed", committedItems: first.plan.items.length,
      loadedItems: first.plan.items.length, reusedItems: 0 });
    expect(fixture.commits[0]).toEqual(first.plan.items.map(item => item.cacheKey));
    const unchanged = await executor.publish(runtime(), { concurrency: 3 });
    expect(unchanged).toMatchObject({ status: "unchanged", loadedItems: 0, preparedItems: 0,
      committedItems: 0, reusedItems: first.plan.items.length });
    const versionOnly = await executor.publish(runtime("1.0.1"), { concurrency: 3 });
    expect(versionOnly).toMatchObject({ status: "committed", loadedItems: 0,
      reusedItems: first.plan.items.length, committedItems: first.plan.items.length });
    expect(fixture.loads).toHaveLength(first.plan.items.length);
    expect(fixture.commits).toHaveLength(2);
    const qualityOnly = await executor.publish(runtime("1.0.1"), { concurrency: 3, bakeQuality: "quality" });
    expect(qualityOnly).toMatchObject({ status: "committed", loadedItems: 1,
      reusedItems: first.plan.items.length - 1, releasedItems: 1 });
    expect(qualityOnly.plan.planHash).not.toBe(versionOnly.plan.planHash);
    const changed = await executor.publish(runtime("1.0.2", 0.25), { concurrency: 3, bakeQuality: "quality" });
    expect(changed).toMatchObject({ status: "committed", loadedItems: 1,
      reusedItems: first.plan.items.length - 1, releasedItems: 1 });
    executor.dispose();
  });

  it("deduplicates identical pipeline hashes without dropping their logical package references", async () => {
    const value = runtime("1.0.0", 0, [shader, shaderAlias("deep.shader.alias")]);
    const plan = buildRuntimePackagePrewarmPlan(value);
    const pipelineItems = plan.items.filter(item => item.type === "shader-pipeline");
    expect(pipelineItems).toHaveLength(shader.passes.length * 2);
    expect(plan.budget.deduplicatedItems).toBe(shader.passes.length);
    expect(plan.budget.plannedItems).toBe(plan.items.length - shader.passes.length);
    const fixture = immediate(), executor = new RuntimePackagePrewarmExecutor(fixture.adapter);
    const result = await executor.publish(value, { concurrency: 4 });
    expect(result).toMatchObject({ status: "committed", loadedItems: plan.budget.plannedItems,
      committedItems: plan.items.length });
    expect(fixture.loads).toHaveLength(plan.budget.plannedItems);
    expect(fixture.commits[0]).toHaveLength(plan.items.length);
    executor.dispose(); expect(fixture.releases).toHaveLength(plan.budget.plannedItems);
  });

  it("bounds concurrency from one through sixteen", async () => {
    let active = 0, peak = 0;
    const fixture = immediate({ async load(item) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return { key: item.cacheKey };
    } });
    const executor = new RuntimePackagePrewarmExecutor(fixture.adapter);
    expect((await executor.publish(runtime(), { concurrency: 2 })).status).toBe("committed");
    expect(peak).toBe(2);
    expect((await executor.publish(runtime("1.0.1", 0.1), { concurrency: 16 })).concurrency).toBe(16);
    await expect(executor.publish(runtime("1.0.2", 0.2), { concurrency: 0 })).rejects.toThrow(/1 through 16/);
    await expect(executor.publish(runtime("1.0.2", 0.2), { concurrency: 17 })).rejects.toThrow(/1 through 16/);
  });

  it("cancels without commit and releases work that ignores AbortSignal", async () => {
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const fixture = immediate({ async load(item) { started(); await wait; return { key: item.cacheKey }; } });
    const executor = new RuntimePackagePrewarmExecutor(fixture.adapter), controller = new AbortController();
    const pending = executor.publish(runtime(), { concurrency: 1, signal: controller.signal });
    await entered; controller.abort(new Error("cancelled")); finish();
    expect(await pending).toMatchObject({ status: "aborted", committedItems: 0, releasedItems: 1 });
    expect(fixture.commits).toHaveLength(0); expect(executor.activePlan).toBeUndefined();
  });

  it("rejects late superseded work while the latest package publishes", async () => {
    let entered!: () => void, finish!: () => void;
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    const late = new Promise<void>(resolve => { finish = resolve; });
    const fixture = immediate({ async load(item, packageValue) {
      if (packageValue.packageVersion === "1.0.0") { entered(); await late; }
      return { key: item.cacheKey };
    } });
    const executor = new RuntimePackagePrewarmExecutor(fixture.adapter);
    const stale = executor.publish(runtime(), { concurrency: 1 }); await firstEntered;
    const latest = await executor.publish(runtime("1.0.1", 0.25), { concurrency: 2 });
    finish();
    expect(latest.status).toBe("committed");
    expect(await stale).toMatchObject({ status: "superseded", committedItems: 0, releasedItems: 1 });
    expect(executor.activePlan?.packageHash).toBe(latest.plan.packageHash);
    expect(fixture.commits).toHaveLength(1);
  });

  it("keeps the last correct publication when prepare or commit fails", async () => {
    let failPrepare = false, failCommit = false;
    const fixture = immediate({ async prepare(item) {
      if (failPrepare && item.type === "resource" && item.resourceKind === "render-packet") throw new Error("prepare failed");
      return { key: item.cacheKey };
    }, commit(_plan: RuntimePackagePrewarmPlan,
      _candidates: readonly RuntimePackagePrewarmCandidate<Loaded, Prepared>[]) {
      if (failCommit) throw new Error("commit failed");
    } });
    const executor = new RuntimePackagePrewarmExecutor(fixture.adapter);
    const stable = await executor.publish(runtime()); expect(stable.status).toBe("committed");
    failPrepare = true;
    expect(await executor.publish(runtime("1.0.1", 0.25))).toMatchObject({ status: "failed", failure: "prepare failed" });
    expect(executor.activePlan?.packageHash).toBe(stable.plan.packageHash);
    failPrepare = false; failCommit = true;
    expect(await executor.publish(runtime("1.0.2", 0.5))).toMatchObject({ status: "failed", failure: "commit failed" });
    expect(executor.activePlan?.packageHash).toBe(stable.plan.packageHash);
  });
});
