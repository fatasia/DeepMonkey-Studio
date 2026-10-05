import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authoredShadowPipelines } from "./authoredShadowPipelines.js";
import { createPipelinesBuild } from "./pipelines.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { RED: 1, ALL: 15 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 与 pipelines.test.ts 同形的最小设备桩(本文件只消费 shadow 变体计数)。
function fixture() {
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const shader = { getCompilationInfo: vi.fn(async () => ({ messages: [] })) } as unknown as GPUShaderModule;
  const device = {
    createShaderModule: vi.fn(() => shader),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
      descriptors.push(descriptor); return { descriptor } as unknown as GPURenderPipeline;
    }),
  };
  return { device: device as unknown as GPUDevice, descriptors };
}

// 2026-10-06 断链归因回归:作者阴影帧的首帧验证经 authoredShadowPipelines 取变体,
// 分级首版只保 plain solid → authored solid 缺失 → validate 内 throw,且错误被候选
// 事务(prepareStudioRendererCandidate)静默吞掉,backend-create 链无 console 断裂。
describe("first-frame shadow tiering authored subset contract", () => {
  it("keeps authored solid shadows critical and rebuilds the authored view after release", async () => {
    const f = fixture();
    const build = await createPipelinesBuild(f.device, "bgra8unorm", {} as GPUBindGroupLayout, true, false, true,
      { firstFrameMainKeys: ["material/depth/ccw"] });
    // release 前:plain+authored solid ×3 raster = 6 条 critical,mask×12 零创建。
    expect(build.pipelines.shadowPipelines.size).toBe(6);
    // authored 视图只含 authored solid 3 条,不 throw(mask 缺失交给 packetDraw mask-skip)。
    expect(authoredShadowPipelines(build.pipelines).shadowPipelines.size).toBe(3);
    await build.criticalReady;
    build.releaseDeferredQueues();
    await build.ready;
    // release 后全量 18(plain 9 + authored 9),size 键缓存失效 → 视图重建为 9 条。
    expect(build.pipelines.shadowPipelines.size).toBe(18);
    const afterRelease = authoredShadowPipelines(build.pipelines);
    expect(afterRelease.shadowPipelines.size).toBe(9);
    expect(afterRelease.shadowPipelines.get("maskPlain/ccw")).toBeDefined();
  });
});
