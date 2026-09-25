import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { ServerRequestError } from "@bim-studio/server-sdk";

const api = vi.hoisted(() => ({ saveProbeGridBake: vi.fn(), loadProbeGridBake: vi.fn() }));
vi.mock("../api", () => ({ api }));

import { fetchPersistedProbeGridBake, persistProbeGridBake } from "./probeGridBakePersistence";
import { probeGridBakeForPayload, probeGridBakeSourceHash,
  resetProbeGridBakeSessionForTest, storeProbeGridBake } from "./probeGridBakePublicationSession";

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  resetProbeGridBakeSessionForTest();
});

function scene(id = "scene", overrides: Partial<SceneSnapshot> = {}): SceneSnapshot {
  return { schemaVersion: 1, id, projectId: "project", name: "Scene", primitives: [], measurements: [],
    models: [], camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } },
    createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z", ...overrides } as SceneSnapshot;
}
function entry(probeCount = 8) {
  return { bake: { origin: [0, 0, 0] as const, spacing: 4, gridSize: [2, 2, 2] as const,
    probes: Array.from({ length: probeCount }, () => ({ irradiance: [1, 2, 3] as const, validity: 1,
      meanDistance: 0, distanceVariance: 0 })) },
    probeCount, coveredCount: probeCount, bakedAt: "2026-09-25T00:00:00Z" };
}

describe("probeGridBakePersistence（服务端持久化桥）", () => {
  it("persistProbeGridBake：按当前场景语义哈希上送会话条目（键与 probeGridBakeSourceHash 同源）", async () => {
    const input = scene();
    const baked = entry();
    await persistProbeGridBake(input, baked);
    expect(api.saveProbeGridBake).toHaveBeenCalledExactlyOnceWith("scene", expect.objectContaining({
      sourceHash: probeGridBakeSourceHash(input), bake: baked.bake,
      probeCount: baked.probeCount, coveredCount: baked.coveredCount, bakedAt: baked.bakedAt }));
  });

  it("persistProbeGridBake：失败静默降级（console.warn，不 reject，会话态不受影响）", async () => {
    api.saveProbeGridBake.mockRejectedValueOnce(new ServerRequestError("服务不可达", 503, null));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(persistProbeGridBake(scene(), entry())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("持久化烘焙结果失败"));
  });

  it("fetchPersistedProbeGridBake：命中回填后 forPayload 可取；语义变化（改名）即失配不带", async () => {
    const input = scene();
    const baked = entry();
    api.loadProbeGridBake.mockResolvedValueOnce({ sourceHash: probeGridBakeSourceHash(input),
      bake: baked.bake, probeCount: baked.probeCount, coveredCount: baked.coveredCount, bakedAt: baked.bakedAt });
    const restored = await fetchPersistedProbeGridBake(input);
    expect(restored?.bake).toEqual(baked.bake);
    // 回填 = 写回发布会话态（视口 effect 的动作），发布链随即可取。
    storeProbeGridBake(input, restored!);
    expect(probeGridBakeForPayload(input)).toEqual(baked.bake);
    // 场景语义变化后哈希失配：自然取不到，绝不携带陈旧烘焙。
    const edited = scene("scene", { name: "Renamed" });
    expect(probeGridBakeForPayload(edited)).toBeUndefined();
  });

  it("fetchPersistedProbeGridBake：404（无持久化烘焙）静默返回 undefined 且不告警", async () => {
    api.loadProbeGridBake.mockRejectedValueOnce(new ServerRequestError("没有已持久化的探针烘焙", 404, { message: "404" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await fetchPersistedProbeGridBake(scene())).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("fetchPersistedProbeGridBake：其余错误降级返回 undefined 并留诊断；键失配响应同样拒绝", async () => {
    api.loadProbeGridBake.mockRejectedValueOnce(new Error("network down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await fetchPersistedProbeGridBake(scene())).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("读取持久化烘焙结果失败"));
    // 服务端响应的 sourceHash 与本地计算不一致（理论上的错位存储）时按未命中处理。
    api.loadProbeGridBake.mockResolvedValueOnce({ sourceHash: "f".repeat(64), bake: entry().bake });
    warn.mockClear();
    expect(await fetchPersistedProbeGridBake(scene())).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
