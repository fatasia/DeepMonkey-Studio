import { buildDeepRuntimePackage } from "../src/runtimePackage/builder.js";
import { RuntimeResourcePrewarmExecutor } from "../src/runtimePackage/resourcePrewarmExecutor.js";
import { runtimeResourcePrewarmStrategy } from "../src/runtimePackage/resourcePrewarmPlan.js";
import type { RuntimeResourcePrewarmAdapter } from "../src/runtimePackage/resourcePrewarmTypes.js";

export interface LifecycleSample {
  readonly phase: string;
  readonly generation: number;
  readonly activeGeneration: number;
  readonly cpuResources: number;
}
export interface LifecycleScenario { readonly id: string; readonly expected: readonly LifecycleSample[] }
export interface LifecycleManifest { readonly scenarios: readonly LifecycleScenario[] }

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function runtime(generation: number) {
  return buildDeepRuntimePackage({ packageId: "j3.lifecycle", packageVersion: `1.0.${generation}`,
    renderPacket: { id: "scene", revision: generation, value: {
      geometries: [{ id: "triangle", revision: generation,
        vertices: new Float32Array([generation, 0, 0, 0, 0, 1, generation + 1, 0, 0, 0, 0, 1, generation, 1, 0, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]) }],
      materials: [{ id: "surface", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
      instances: [{ id: "mesh", geometry: "triangle", material: "surface",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    } } });
}

/** Drives the production executor; samples come from adapter entry and settled results. */
async function scenario(id: string) {
  const samples: LifecycleSample[] = [], resources = new Set<object>(), staged = new Set<number>();
  const entered = deferred(), resume = deferred();
  const blocked = ["superseded-completion", "cancelled-retains-active", "dispose-pending"].includes(id);
  const packages = new Map([1, 2, 3].map(generation => [generation, runtime(generation)]));
  let activeGeneration = 0;
  const record = (phase: string, generation: number) => samples.push({ phase, generation,
    activeGeneration, cpuResources: resources.size });
  const adapter: RuntimeResourcePrewarmAdapter<{ generation: number }, object> = {
    async load(_item, value) {
      const generation = Number(value.packageVersion.split(".").at(-1));
      if (!staged.has(generation)) { staged.add(generation); record("staging", generation); }
      if (generation === 2 && blocked) { entered.resolve(); await resume.promise; }
      const resource = { generation }; resources.add(resource); return resource;
    },
    async prepare(_item, loaded) {
      if (loaded.generation === 2 && id === "failed-retains-active") throw new Error("planned prepare failure");
      return loaded;
    },
    commit(plan) {
      const generation = [...packages].find(([, value]) => value.packageHash.value === plan.packageHash)?.[0];
      if (!generation) throw new Error("Unexpected runtime generation");
      activeGeneration = generation;
    },
    release(_item, loaded) {
      if (!resources.delete(loaded)) throw new Error("Resource released twice");
    },
  };
  const executor = new RuntimeResourcePrewarmExecutor(adapter, runtimeResourcePrewarmStrategy);
  const settled = async (pending: ReturnType<typeof executor.publish>) => {
    const result = await pending;
    if (result.releaseFailures.length) throw new Error(result.releaseFailures.join("; "));
    record(result.status === "aborted" ? "cancelled" : result.status, result.generation);
  };
  const dispose = () => { executor.dispose(); activeGeneration = 0; record("disposed", 0); };
  await settled(executor.publish(packages.get(1), { concurrency: 1 }));
  if (!blocked) await settled(executor.publish(packages.get(2), { concurrency: 1 }));
  else {
    const controller = new AbortController();
    const pending = executor.publish(packages.get(2), { concurrency: 1, signal: controller.signal });
    await entered.promise;
    if (id === "superseded-completion") await settled(executor.publish(packages.get(3), { concurrency: 1 }));
    if (id === "cancelled-retains-active") controller.abort("planned cancellation");
    if (id === "dispose-pending") dispose();
    resume.resolve(); await settled(pending);
  }
  dispose();
  if (resources.size !== 0 || executor.activePlan !== undefined) throw new Error("Disposed executor retains resources");
  await executor.publish(packages.get(3)).then(() => { throw new Error("Disposed executor accepted publication"); }, () => {});
  return { id, samples };
}

export async function runJ3LifecycleProbe(manifest: LifecycleManifest) {
  const scenarios = [];
  for (const entry of manifest.scenarios) {
    if (!["success", "failed-retains-active", "superseded-completion", "cancelled-retains-active", "dispose-pending"].includes(entry.id)) {
      throw new Error(`Unsupported lifecycle scenario: ${entry.id}`);
    }
    scenarios.push(await scenario(entry.id));
  }
  return { host: "ts-production-resource-prewarm", scope: "production-host-components-cpu", scenarios };
}
