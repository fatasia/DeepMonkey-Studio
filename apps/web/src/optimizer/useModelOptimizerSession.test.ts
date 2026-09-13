import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import type { ModelOptimizationOptions } from "./modelOptimizer";

const harness = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, updates: [] as unknown[], convert: vi.fn() }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, (next: unknown) => harness.updates.push(next)],
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
}));
vi.mock("../api", () => ({ api: {} }));
vi.mock("./modelOptimizerAssets", () => ({ convertProjectModelToGlb: harness.convert }));
vi.mock("./modelOptimizerWorkerClient", () => ({ ModelOptimizerWorkerClient: class {
  async layers() { return { binary: new Uint8Array([1, 2, 3]), layers: [], statistics: { bytes: 3 } }; }
  terminate() {}
} }));
import { useModelOptimizerSession } from "./useModelOptimizerSession";

beforeEach(() => { harness.effects.length = 0; harness.updates.length = 0; harness.convert.mockReset(); });

describe("optimizer linked-resource loading", () => {
  it("restarts the direct model import when StrictMode replays a cancelled mount", async () => {
    harness.convert.mockImplementation(async (_model, _progress, signal: AbortSignal) => {
      await Promise.resolve(); signal.throwIfAborted();
      return new File([new Uint8Array([1])], "pump.glb");
    });
    const model = { id: "pump", status: "ready", manifest: { geometryUrl: "/assets/pump.glb" } } as ModelRecord;
    useModelOptimizerSession("zh-CN", { id: "project", models: [model] } as ProjectRecord, {} as ModelOptimizationOptions, undefined, "pump");
    const cleanups = harness.effects.map(effect => effect());
    cleanups.forEach(cleanup => cleanup?.());
    harness.effects.forEach(effect => effect());
    await vi.waitFor(() => expect(harness.updates).toContain("模型已载入，可调整参数后开始优化"));
    expect(harness.convert).toHaveBeenCalledTimes(2);
    expect(harness.updates.filter(value => typeof value === "object" && value !== null && "baseFile" in value)).toHaveLength(1);
  });
});
