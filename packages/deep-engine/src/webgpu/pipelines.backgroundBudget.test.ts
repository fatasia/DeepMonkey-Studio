import { afterEach, it, expect, vi } from "vitest";
import { createPipelinesBuild } from "./pipelines.js";

afterEach(() => vi.unstubAllGlobals());

it("bounds every background PSO across static/deformed builds on the same device", async () => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { RED: 1, ALL: 15 });
  let background = false, inFlight = 0, maximum = 0;
  const pending: Array<() => void> = [], labels: string[] = [];
  const device = {
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (value: unknown) => value,
    createPipelineLayout: (value: unknown) => value,
    createRenderPipelineAsync: (descriptor: GPURenderPipelineDescriptor) => {
      const pipeline = { descriptor } as unknown as GPURenderPipeline;
      if (!background) return Promise.resolve(pipeline);
      labels.push(descriptor.label!); maximum = Math.max(maximum, ++inFlight);
      return new Promise<GPURenderPipeline>(resolve => pending.push(() => { inFlight--; resolve(pipeline); }));
    },
  } as unknown as GPUDevice;
  const lighting = {} as GPUBindGroupLayout;
  const builds = await Promise.all([false, true].map(deformation => createPipelinesBuild(device,
    "bgra8unorm", lighting, true, false, true,
    { deformation, firstFrameMainKeys: ["material/depth/ccw"] })));
  await Promise.all(builds.map(build => build.criticalReady));
  background = true;
  for (const build of builds) build.releaseDeferredQueues();
  let completed = false;
  const ready = Promise.all(builds.map(build => build.ready)).then(() => { completed = true; });
  for (let iteration = 0; iteration < 500 && !completed; iteration++) {
    await Promise.resolve();
    if (pending.length) pending.shift()!();
  }
  expect(maximum).toBe(2);
  expect(completed).toBe(true);
  await ready;
  expect(labels.some(label => label.startsWith("Deep shadow"))).toBe(true);
  expect(labels.some(label => label.startsWith("Deep virtual shadow page"))).toBe(false);
  expect(builds.every(build => build.pipelines.pageShadowPipelines.size === 0)).toBe(true);
  expect(builds.every(build => build.pipelines.shadowPipelines.size === 18)).toBe(true);
  expect(inFlight).toBe(0);
});
