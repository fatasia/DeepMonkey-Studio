/// <reference types="@webgpu/types" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { bakeClusterLodDag } from "../rayTracing/clusterLodBake.js";
import { selectClusterLod, type ClusterLodCamera } from "../rayTracing/clusterLodSelection.js";
import { ClusterLodRenderSlot, type ClusterLodSceneStaging } from "./clusterLodRenderSlot.js";
import { deriveClusterLodCamera, resolveClusterLodSlotOption } from "./clusterLodSlotSupport.js";
import type { DeviceSession } from "./deviceSession.js";

const USAGE = { STORAGE: 128, INDIRECT: 256, COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1, UNIFORM: 64, INDEX: 16, VERTEX: 32 };

function staging(): ClusterLodSceneStaging {
  const nx = 8, nz = 4, stride = nx + 1, vertices: number[] = [], indices: number[] = [];
  for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++) vertices.push(x, 0, z);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const a = z * stride + x;
    indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
  }
  return { ...bakeClusterLodDag({ geometryId: "slot-grid", vertices: Float32Array.from(vertices),
    indices: Uint32Array.from(indices), level0ClusterSize: 16, levelCount: 2 }), pixelThreshold: 1 };
}

const camera: ClusterLodCamera = deriveClusterLodCamera({ eye: [4, 6, 10], target: [4, 0, 2] }, 64, Math.PI / 4, 1);

interface SlotBuffer {
  size: number; usage: number; label: string;
  nextWords: ArrayBuffer[]; mappedRange: ArrayBuffer;
  destroy: ReturnType<typeof vi.fn>;
  mapAsync: ReturnType<typeof vi.fn>;
  getMappedRange: () => ArrayBuffer;
  unmap: ReturnType<typeof vi.fn>;
}

function fixture(stage = staging()) {
  vi.stubGlobal("GPUBufferUsage", USAGE);
  vi.stubGlobal("GPUMapMode", { READ: 1 });
  const owned = new Set<GPUBuffer>();
  const buffers: SlotBuffer[] = [];
  const bundleEncoder = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(), drawIndexedIndirect: vi.fn(), finish: vi.fn(() => ({} as GPURenderBundle)) };
  const device = { limits: { maxBufferSize: 2 ** 28, maxColorAttachments: 8, maxBindGroups: 4 },
    features: new Set<string>(), queue: { writeBuffer: vi.fn() },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor & { label?: string }) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage, label: descriptor.label ?? "",
        nextWords: [] as ArrayBuffer[], mappedRange: new ArrayBuffer(Math.max(4, descriptor.size)),
        destroy: vi.fn(), mapAsync: undefined as unknown as SlotBuffer["mapAsync"],
        getMappedRange: () => buffer.mappedRange, unmap: vi.fn() };
      buffer.mapAsync = vi.fn(async () => {
        const next = buffer.nextWords.shift();
        if (next) new Uint8Array(buffer.mappedRange).set(new Uint8Array(next));
      });
      buffers.push(buffer);
      return buffer;
    }),
    createShaderModule: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createRenderBundleEncoder: vi.fn(() => bundleEncoder) } as unknown as GPUDevice;
  const session = { state: "ready", device,
    own: (buffer: GPUBuffer) => { owned.add(buffer); return buffer; },
    release: vi.fn((buffer: GPUBuffer) => { if (owned.delete(buffer)) buffer.destroy(); }) };
  const slot = ClusterLodRenderSlot.create(session as unknown as DeviceSession, stage);
  const byLabel = (fragment: string) => buffers.find(buffer => buffer.label.includes(fragment))!;
  return { slot, session, device, buffers, bundleEncoder, owned,
    selectionStaging: () => byLabel("selection readback"), faultsStaging: () => byLabel("faults readback") };
}

function queueGpuWords(f: ReturnType<typeof fixture>, dag: ClusterLodSceneStaging["dag"], cam: ClusterLodCamera): void {
  const selection = selectClusterLod(dag, cam).selection;
  f.selectionStaging().nextWords = [selection.slice().buffer as ArrayBuffer];
  f.faultsStaging().nextWords = [new Uint32Array([0]).buffer as ArrayBuffer];
}

afterEach(() => vi.unstubAllGlobals());

function frameEncoder() {
  return { beginComputePass: vi.fn(() => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(),
    dispatchWorkgroups: vi.fn(), end: vi.fn() })), copyBufferToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
}



describe("cluster LOD render slot (G1-S1)", () => {
  it("gate defaults to closed and rejects non-boolean capability", () => {
    expect(resolveClusterLodSlotOption(undefined)).toBe(false);
    expect(resolveClusterLodSlotOption(false)).toBe(false);
    expect(resolveClusterLodSlotOption(true)).toBe(true);
    expect(() => resolveClusterLodSlotOption("yes")).toThrow("must be boolean");
  });

  it("deriveClusterLodCamera matches the selection contract and rejects degenerate input", () => {
    const derived = deriveClusterLodCamera({ eye: [0, 0, 5], target: [3, 4, 5] }, 2160, Math.PI / 3, 2);
    expect(derived.forward).toEqual([0.6, 0.8, 0]);
    expect(derived.tanHalfFovY).toBeCloseTo(Math.tan(Math.PI / 6), 15);
    expect(derived.viewportHeightPixels).toBe(2160);
    expect(() => deriveClusterLodCamera({ eye: [1, 1, 1], target: [1, 1, 1] }, 64, Math.PI / 4, 1)).toThrow("distinct finite");
    expect(() => deriveClusterLodCamera({ eye: [0, 0, 1], target: [0, 0, 0] }, 0, Math.PI / 4, 1)).toThrow("positive");
  });

  it("staging validation fails closed before any GPU resource is created", () => {
    expect(() => fixture({ ...staging(), dag: { ...staging().dag, nodes: [] } })).toThrow("staging rejected");
    expect(() => fixture({ ...staging(), levelGeometry: [] })).toThrow("level geometry");
    expect(() => fixture({ ...staging(), pixelThreshold: 0 })).toThrow("pixelThreshold");
  });

  it("encodes selection only when the camera changes and reuses the idle path", async () => {
    const f = fixture();
    const encoder = frameEncoder();
    expect(f.slot.encodeFrame(encoder)).toBe(false);
    f.slot.updateCamera(camera);
    expect(f.slot.encodeFrame(encoder)).toBe(true);
    expect(f.slot.encodeFrame(encoder)).toBe(false);
    await f.slot.ingest();
    queueGpuWords(f, staging().dag, camera);
    f.slot.updateCamera(camera);
    expect(f.slot.encodeFrame(encoder)).toBe(false);
  });

  it("ingests CPU-matching selection into commands and draws the bundle", async () => {
    const f = fixture();
    f.slot.updateCamera(camera);
    const encoder = frameEncoder();
    f.slot.encodeFrame(encoder);
    queueGpuWords(f, staging().dag, camera);
    await f.slot.ingest();
    const metrics = f.slot.metrics();
    expect(metrics.warming).toBe(false);
    expect(metrics.draws).toBeGreaterThan(0);
    expect(metrics.triangles).toBeGreaterThan(0);
    const pass = { executeBundles: vi.fn() };
    const stats = f.slot.draw(pass as unknown as GPURenderPassEncoder);
    expect(stats!.draws).toBe(metrics.draws);
    expect(pass.executeBundles).toHaveBeenCalledTimes(1);
    expect(f.bundleEncoder.drawIndexedIndirect).toHaveBeenCalledTimes(metrics.draws);
  });

  it("pixel threshold moves the frontier end-to-end: fine threshold fans out, coarse collapses (golden)", async () => {
    // G1-S1 端到端黄金用例(2026-10-05):同一 DAG 同一相机,仅 pixelThreshold 不同 ——
    // 1px(Nanite 式默认)→ 叶层 4 cluster 全细化(4 draw,全 level 0);64px → 前沿
    // 收敛到 level 1 根(1 draw)。三角形覆盖恒定 64(LOD 换细节不丢几何)。数值钉死:
    // 选层数学(clusterLodSelection 投影误差)、plan 前沿闭合、executor 命令数任一漂移即红。
    const fine = fixture(staging());
    fine.slot.updateCamera(camera);
    fine.slot.encodeFrame(frameEncoder());
    queueGpuWords(fine, staging().dag, camera);
    await fine.slot.ingest();
    expect(fine.slot.metrics()).toMatchObject({ draws: 4, triangles: 64, frontierMaxLevel: 0,
      warming: false });

    const coarseStage = { ...staging(), pixelThreshold: 64 };
    const coarse = fixture(coarseStage);
    coarse.slot.updateCamera(deriveClusterLodCamera({ eye: [4, 6, 10], target: [4, 0, 2] }, 64,
      Math.PI / 4, 64));
    coarse.slot.encodeFrame(frameEncoder());
    queueGpuWords(coarse, coarseStage.dag, deriveClusterLodCamera({ eye: [4, 6, 10], target: [4, 0, 2] },
      64, Math.PI / 4, 64));
    await coarse.slot.ingest();
    expect(coarse.slot.metrics()).toMatchObject({ draws: 1, triangles: 64, frontierMaxLevel: 1,
      warming: false });
    // 单调不变式:阈值变粗 ⇒ 前沿上移(frontierMaxLevel 增)、draw 收敛(4→1)、覆盖不变。
    expect(coarse.slot.metrics().frontierMaxLevel).toBeGreaterThan(fine.slot.metrics().frontierMaxLevel);
    expect(coarse.slot.metrics().draws).toBeLessThan(fine.slot.metrics().draws);
    expect(coarse.slot.metrics().triangles).toBe(fine.slot.metrics().triangles);
  });

  it("an all-empty frontier degrades to no-op draw slots instead of failing", async () => {
    const bounds = { boundsMin: [0, 0, 0] as const, boundsMax: [1, 1, 1] as const };
    const children = ["l0-c0", "l0-c1", "l0-c2", "l0-c3"];
    const stage = { dag: { geometryId: "slot-empty", leafTriangleTotal: 0, nodes: [
      { id: "l1-root", level: 1, error: 4, firstTriangle: 0, triangleCount: 0, children, ...bounds },
      ...children.map(id => ({ id, level: 0, error: 0, firstTriangle: 0, triangleCount: 0, children: [], ...bounds }))] },
      levelGeometry: [{ vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
        indices: Uint32Array.of(0, 1, 2) },
      { vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.of(0, 1, 2) }] };
    const f = fixture(stage);
    f.slot.updateCamera(camera);
    const encoder = frameEncoder();
    f.slot.encodeFrame(encoder);
    const selection = new Uint32Array(5).fill(0xffff_ffff);
    f.selectionStaging().nextWords = [selection.buffer as ArrayBuffer];
    f.faultsStaging().nextWords = [new Uint32Array([0]).buffer as ArrayBuffer];
    await f.slot.ingest();
    const pass = { executeBundles: vi.fn() };
    expect(f.slot.draw(pass as unknown as GPURenderPassEncoder)).toEqual({ draws: 4, triangles: 0 });
    // 合同：空 cluster 保留为 indexCount=0 的 no-op 绘制槽位（plan 头注释），GPU 侧零三角形。
    expect(f.bundleEncoder.drawIndexedIndirect).toHaveBeenCalledTimes(4);
    expect(f.bundleEncoder.drawIndexedIndirect.mock.calls.every(
      ([buffer, offset]) => buffer === undefined || offset % 20 === 0)).toBe(true);
  });

  it("nonzero fault sentinel and contract-violating slots fail closed with a sticky reason", async () => {
    const f = fixture();
    f.slot.updateCamera(camera);
    const encoder = frameEncoder();
    f.slot.encodeFrame(encoder);
    f.selectionStaging().nextWords = [new Uint32Array(staging().dag.nodes.length).fill(0).buffer as ArrayBuffer];
    f.faultsStaging().nextWords = [new Uint32Array([3]).buffer as ArrayBuffer];
    await f.slot.ingest();
    expect(f.slot.metrics().fallbackReason).toContain("3 faults");
    expect(f.slot.draw({} as unknown as GPURenderPassEncoder)).toBeUndefined();

    const g = fixture();
    g.slot.updateCamera(camera);
    g.slot.encodeFrame(encoder);
    g.selectionStaging().nextWords = [new Uint32Array(staging().dag.nodes.length).fill(7).buffer as ArrayBuffer];
    g.faultsStaging().nextWords = [new Uint32Array([0]).buffer as ArrayBuffer];
    await g.slot.ingest();
    expect(g.slot.metrics().fallbackReason).toContain("rejected GPU selection");
  });

  it("a frontier beyond the draw budget shares the sticky fail-closed path (budget enforced in executor.encode)", async () => {
    // 超容断言本体在两处：fixture 计划层（clusterLodCadFixture.test：plan.drawCount = MAX+1 可达）
    // 与 executor（clusterLodIndirectExecutor.test："over-budget plans" 抛 "draw budget"）。
    // 槽位层验证 ingest 的统一 catch：plan 派生/编码抛错 → sticky fallback、零绘制、不抛进渲染循环。
    const f = fixture();
    f.slot.updateCamera(camera);
    f.slot.encodeFrame(frameEncoder());
    f.selectionStaging().nextWords = [new Uint32Array(staging().dag.nodes.length).fill(7).buffer as ArrayBuffer];
    f.faultsStaging().nextWords = [new Uint32Array([0]).buffer as ArrayBuffer];
    await f.slot.ingest();
    expect(f.slot.metrics().fallbackReason).toBeDefined();
    expect(f.slot.metrics().draws).toBe(0);
    expect(f.slot.metrics().warming).toBe(false);
  });

  it("frame-signature unsupported note and dispose release everything exactly once", async () => {
    const f = fixture();
    f.slot.updateCamera(camera);
    const encoder = frameEncoder();
    f.slot.encodeFrame(encoder);
    queueGpuWords(f, staging().dag, camera);
    await f.slot.ingest();
    const commands = f.buffers.filter(buffer => buffer.usage === (USAGE.STORAGE | USAGE.INDIRECT | USAGE.COPY_DST));
    expect(commands.length).toBe(1);
    f.slot.noteFrameSignatureUnsupported();
    expect(f.slot.metrics().fallbackReason).toContain("plain HDR");
    f.slot.dispose();
    f.slot.dispose();
    expect(f.owned.size).toBe(0);
    expect(commands[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(() => f.slot.updateCamera(camera)).toThrow("disposed");
    expect(f.slot.metrics().draws).toBe(0);
  });
});
