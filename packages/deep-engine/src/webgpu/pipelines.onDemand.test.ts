import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPipelinesBuild } from "./pipelines.js";

beforeEach(() => { vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 }); vi.stubGlobal("GPUColorWrite", { RED: 1, ALL: 15 }); });
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const device = {
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (value: unknown) => value, createPipelineLayout: (value: unknown) => value,
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
      descriptors.push(descriptor); return { descriptor } as unknown as GPURenderPipeline;
    }),
  } as unknown as GPUDevice;
  return { device, descriptors };
}
const keys = ["material/depth/ccw"];
it("does not compile unused static or pose mains after publication and admits later material keys exactly once", async () => {
  const f = fixture();
  const builds = await Promise.all([false, true].map(deformation => createPipelinesBuild(f.device,
    "bgra8unorm", {} as GPUBindGroupLayout, true, false, true,
    { deformation, firstFrameMainKeys: keys, onDemandMain: true })));
  for (const build of builds) { await build.criticalReady; build.releaseDeferredQueues(); }
  await Promise.all(builds.map(build => build.ready));
  expect(f.descriptors.filter(value => value.label?.startsWith("Deep forward"))).toHaveLength(3);
  expect(builds.map(build => build.pipelines.mainPipelines.size)).toEqual([2, 1]);
  expect(builds[1]!.pipelines.mainPipelines.has("plain/depth/ccw")).toBe(false);
  for (const build of builds) {
    const prepare = build.pipelines.prepareMainKeys!;
    await Promise.all([prepare(["material/blend/double", "material/blend/double"]), prepare(["material/blend/double"])]);
    expect(build.pipelines.mainPipelines.has("material/blend/double")).toBe(true);
    expect(prepare(["material/blend/double"])).toBeUndefined();
    expect(() => prepare(["material/blend/ccw/a2c"])).toThrow("Missing main pipeline variant");
  }
  expect(f.descriptors.filter(value => value.label?.startsWith("Deep forward"))).toHaveLength(5);
  await builds[1]!.pipelines.prepareMainKeys!(["plain/depth/ccw"]);
  expect(builds[1]!.pipelines.mainPipelines.has("plain/depth/ccw")).toBe(true);
  expect(builds[1]!.pipelines.main).toBeDefined();
});
it("propagates driver compilation failure without publishing the missing key", async () => {
  const f = fixture();
  const build = await createPipelinesBuild(f.device, "bgra8unorm", {} as GPUBindGroupLayout,
    true, false, false, { firstFrameMainKeys: keys, onDemandMain: true });
  await build.criticalReady; build.releaseDeferredQueues(); await build.ready;
  vi.mocked(f.device.createRenderPipelineAsync).mockRejectedValueOnce(new Error("driver rejected material"));
  await expect(build.pipelines.prepareMainKeys!(["normal/blend/cw"])).rejects.toThrow("driver rejected material");
  expect(build.pipelines.mainPipelines.has("normal/blend/cw")).toBe(false);
});
it("bounds actual later requests across static and deformed pipeline owners to two compilations", async () => {
  const f = fixture();
  const builds = await Promise.all([false, true].map(deformation => createPipelinesBuild(f.device,
    "bgra8unorm", {} as GPUBindGroupLayout, true, false, false,
    { deformation, firstFrameMainKeys: keys, onDemandMain: true })));
  for (const build of builds) build.releaseDeferredQueues(); await Promise.all(builds.map(build => build.ready));
  const resolves: Array<() => void> = []; let inFlight = 0, maximum = 0;
  vi.mocked(f.device.createRenderPipelineAsync).mockImplementation(descriptor => {
    maximum = Math.max(maximum, ++inFlight);
    return new Promise(resolve => resolves.push(() => { inFlight--; resolve({ descriptor } as unknown as GPURenderPipeline); }));
  });
  let completed = false;
  const ready = Promise.all(builds.map(build => build.pipelines.prepareMainKeys!(["normal/blend/cw", "plain/blend/double"])))
    .then(() => { completed = true; });
  for (let index = 0; index < 200 && !completed; index++) { await Promise.resolve(); resolves.shift()?.(); }
  await ready; expect(maximum).toBe(2); expect(inFlight).toBe(0);
});
