import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createPlaySessionRestore, type PlaySessionRestoreDeps } from "./playSessionRestore";

function snapshot(id = "scene-1"): SceneSnapshot {
  return {
    schemaVersion: 1, id, projectId: "p1", name: "场景", camera: { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 } },
    models: [{ modelId: "a", name: "A", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
    primitives: [{ modelId: "p1", name: "P", kind: "box", color: "#d9a441", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
    measurements: [],
  } as unknown as SceneSnapshot;
}

function deps(overrides: Partial<PlaySessionRestoreDeps> = {}): PlaySessionRestoreDeps & {
  applyFull: ReturnType<typeof vi.fn>;
  applyIncremental: ReturnType<typeof vi.fn>;
  captureLive: ReturnType<typeof vi.fn>;
} {
  const applyFull = vi.fn(async () => undefined);
  const applyIncremental = vi.fn(async () => undefined);
  const captureLive = vi.fn(() => snapshot());
  const impl = {
    engine: () => ({ getAuthorRendererBackend: () => "webgl", hasRestoredSceneSnapshot: () => true }),
    project: () => ({ id: "p1" }),
    captureLive,
    applyFull,
    applyIncremental,
  };
  return { ...impl, ...overrides } as PlaySessionRestoreDeps & {
    applyFull: ReturnType<typeof vi.fn>;
    applyIncremental: ReturnType<typeof vi.fn>;
    captureLive: ReturnType<typeof vi.fn>;
  };
}

describe("C25 Play 会话恢复调度器（增量域重载薄层）", () => {
  it("纯驱动场景 → fast：只走增量分支，全量分支零调用，返回计划供分段账本消费", async () => {
    const d = deps();
    const restore = createPlaySessionRestore(() => d);
    const outcome = await restore.restore(snapshot());
    expect(outcome.path).toBe("incremental");
    expect(outcome.path === "incremental" && outcome.plan.mode).toBe("fast");
    expect(d.applyIncremental).toHaveBeenCalledOnce();
    expect(d.applyFull).not.toHaveBeenCalled();
    expect(restore.isDegraded()).toBe(false);
  });

  it("live 快照缺失（场景未就绪）→ full，且不做差分", async () => {
    const d = deps({ captureLive: vi.fn(() => undefined) });
    const outcome = await createPlaySessionRestore(() => d).restore(snapshot());
    expect(outcome).toEqual({ path: "full", plan: undefined });
    expect(d.applyIncremental).not.toHaveBeenCalled();
  });

  it("进入/退出之间场景被替换（id 不一致）→ full 并带 full 计划", async () => {
    const d = deps({ captureLive: vi.fn(() => snapshot("scene-2")) });
    const outcome = await createPlaySessionRestore(() => d).restore(snapshot());
    expect(outcome.path).toBe("full");
    expect(outcome.path === "full" && outcome.plan).toEqual({ mode: "full", blockedBy: ["scene-identity"] });
  });

  it("播放中模型增删（live 缺实例）→ full，阻断域 models", async () => {
    const live = snapshot();
    (live.models as SceneSnapshot["models"]).length = 0;
    const d = deps({ captureLive: vi.fn(() => live) });
    const outcome = await createPlaySessionRestore(() => d).restore(snapshot());
    expect(outcome).toMatchObject({ path: "full", plan: { mode: "full", blockedBy: ["models"] } });
    expect(d.applyIncremental).not.toHaveBeenCalled();
  });

  it("WebGPU 引擎不尝试增量（与 T30 的 WebGL-only 约束一致），live 快照都不捕获", async () => {
    const d = deps({ engine: () => ({ getAuthorRendererBackend: () => "webgpu", hasRestoredSceneSnapshot: () => true }) });
    const outcome = await createPlaySessionRestore(() => d).restore(snapshot());
    expect(outcome.path).toBe("full");
    expect(d.captureLive).not.toHaveBeenCalled();
    expect(d.applyFull).toHaveBeenCalledOnce();
  });

  it("项目缺失 → 直接走全量（由全量闭包原样抛出 T30 语义）", async () => {
    const d = deps({ project: () => undefined });
    const outcome = await createPlaySessionRestore(() => d).restore(snapshot());
    expect(outcome.path).toBe("full");
    expect(d.applyFull).toHaveBeenCalledOnce();
  });

  it("增量分支抛错 → 异常透传 + 当场降级；同会话重试直接走全量（可重试性不弱于 T30）", async () => {
    const d = deps({ applyIncremental: vi.fn(async () => { throw new Error("增量恢复失败"); }) });
    const restore = createPlaySessionRestore(() => d);
    await expect(restore.restore(snapshot())).rejects.toThrow("增量恢复失败");
    expect(restore.isDegraded()).toBe(true);
    const outcome = await restore.restore(snapshot());
    expect(outcome.path).toBe("full");
    expect(d.applyIncremental).toHaveBeenCalledOnce();
    expect(d.applyFull).toHaveBeenCalledOnce();
  });

  it("增量已执行但恢复代际未完成 → 拒绝 + 降级（T30 P1 同一守卫）", async () => {
    const d = deps({ engine: () => ({ getAuthorRendererBackend: () => "webgl", hasRestoredSceneSnapshot: () => false }) });
    const restore = createPlaySessionRestore(() => d);
    await expect(restore.restore(snapshot())).rejects.toThrow("场景恢复尚未完成");
    expect(restore.isDegraded()).toBe(true);
    expect(d.applyIncremental).toHaveBeenCalledOnce();
  });
});
