import { describe, expect, it } from "vitest";
import type { DynamicPhysicsRuntime, DynamicSoftBodyRuntime } from "../runtimePackage/dynamicSceneRuntime.js";
import { fingerprintFloat64 } from "./physicsTypes.js";
import { createSoftBodyRuntimeSession, SOFT_BODY_BUDGETS, SoftBodyBudgetError } from "./softBodyRuntimeHost.js";

const physicsWith = (softBodies: DynamicSoftBodyRuntime[]): DynamicPhysicsRuntime => ({
  schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true,
  gravity: [0, -9.81, 0], bodies: [], joints: [], softBodies,
});

const clothFlag = (): DynamicSoftBodyRuntime => ({
  kind: "cloth", id: "flag-a", columns: 12, rows: 12, spacing: 0.05, mass: 0.02,
  compliance: 0, damping: 0.01, substeps: 4, perturbation: 0.001, seed: 7,
  origin: [0, 2, 0], pinned: [0, 11],
  wind: { direction: [0, 0, -1], baseSpeed: 2.5, gustFrequency: 0.7, spatialScale: 1.5, seed: 11 },
});

const softBall = (): DynamicSoftBodyRuntime => ({
  kind: "soft-body", id: "ball-a", mass: 0.2, damping: 0.02, substeps: 4, pinned: [],
  positions: [[0, 2, 0], [0.1, 2, 0], [0, 2.1, 0], [0, 2, 0.1], [0.05, 2.12, 0.05]],
  tets: [[0, 1, 2, 4], [0, 1, 3, 4], [0, 2, 3, 4], [1, 2, 3, 4]],
  complianceDistance: 0, complianceVolume: 0, groundY: 0,
});

describe("F6 布料/软体运行时会话", () => {
  it("布料旗:锚点+风场滚动 240 tick,同输入双跑逐位一致(指纹)", () => {
    const run = (): string => {
      const session = createSoftBodyRuntimeSession(physicsWith([clothFlag()]));
      for (let tick = 0; tick < 240; tick += 1) session.step();
      return fingerprintFloat64(session.readout("flag-a")!);
    };
    expect(run()).toBe(run());

    const session = createSoftBodyRuntimeSession(physicsWith([clothFlag()]));
    for (let tick = 0; tick < 240; tick += 1) session.step();
    const positions = session.readout("flag-a")!;
    expect(positions.length).toBe(12 * 12 * 3);
    // 锚点保持初始位置(origin 平移生效;z 含 seed 扰动 ±perturbation):
    // 首锚 (0,2,z₀),尾锚 x=0.55。
    expect(positions[0]).toBe(0);
    expect(positions[1]).toBe(2);
    expect(Math.abs(positions[2]!)).toBeLessThanOrEqual(0.001);
    expect(positions[33]).toBeCloseTo(0.55, 5);
    // 风把旗面吹离平整初始态(z 方向),但不发散。
    const zValues = Array.from(positions.filter((_, i) => i % 3 === 2));
    const zSpread = Math.max(...zValues) - Math.min(...zValues);
    expect(zSpread).toBeGreaterThan(0.01);
    expect(Number.isFinite(zSpread)).toBe(true);
  });

  it("软球落地:groundY 接触驻留不穿透,同输入双跑逐位一致,体积守恒 ≤5%", () => {
    const run = (): { fingerprint: string; finalY: number } => {
      const session = createSoftBodyRuntimeSession(physicsWith([softBall()]));
      for (let tick = 0; tick < 180; tick += 1) session.step();
      const positions = session.readout("ball-a")!;
      return {
        fingerprint: fingerprintFloat64(positions),
        finalY: Math.min(...Array.from(positions.filter((_, i) => i % 3 === 1))),
      };
    };
    const first = run();
    expect(run().fingerprint).toBe(first.fingerprint);
    // 落地:最低粒子被 groundY=0 托住,不穿透。
    expect(first.finalY).toBeGreaterThanOrEqual(-1e-9);
    expect(first.finalY).toBeLessThan(0.2);

    const session = createSoftBodyRuntimeSession(physicsWith([softBall()]));
    for (let tick = 0; tick < 180; tick += 1) session.step();
    const volume = session.volumeError("ball-a");
    expect(volume).toBeDefined();
    expect(volume!.totalRatio).toBeLessThanOrEqual(0.05);
    expect(session.volumeError("flag-a")).toBeUndefined();
  });

  it("快照回放:capture→restore 后重放与原轨迹逐位一致", () => {
    const session = createSoftBodyRuntimeSession(physicsWith([clothFlag(), softBall()]));
    for (let tick = 0; tick < 60; tick += 1) session.step();
    const snapshot = session.capture();
    for (let tick = 0; tick < 60; tick += 1) session.step();
    const forward = session.readout("ball-a")!;
    session.restore(snapshot);
    expect(session.tick).toBe(60);
    for (let tick = 0; tick < 60; tick += 1) session.step();
    expect(Array.from(session.readout("ball-a")!)).toEqual(Array.from(forward));
  });

  it("预算护栏 fail-closed:单体贴算/数量/substeps/总量超限均拒并给原因", () => {
    const bigCloth = (): DynamicSoftBodyRuntime => ({ ...clothFlag(), id: "flag-big", columns: 128, rows: 129 });
    expect(() => createSoftBodyRuntimeSession(physicsWith([bigCloth()]))).toThrow(SoftBodyBudgetError);
    expect(() => createSoftBodyRuntimeSession(physicsWith([bigCloth()]))).toThrow(/16384/);

    const manyBodies = Array.from({ length: SOFT_BODY_BUDGETS.maxBodies + 1 }, (_, index) => ({
      ...clothFlag(), id: `flag-${String(index).padStart(2, "0")}`,
    }));
    expect(() => createSoftBodyRuntimeSession(physicsWith(manyBodies))).toThrow(/数量 17 超出预算 16/);

    expect(() => createSoftBodyRuntimeSession(physicsWith([{ ...clothFlag(), substeps: 32 }])))
      .toThrow(/substeps 32 超出预算 16/);

    const nearBudget: DynamicSoftBodyRuntime[] = Array.from(
      { length: 6 }, (_, index) => ({ ...clothFlag(), id: `flag-${index}`, columns: 128, rows: 96 }),
    );
    expect(() => createSoftBodyRuntimeSession(physicsWith(nearBudget))).toThrow(/粒子总量/);
  });

  it("readout 未知 id 返回 undefined;entries 按字典序暴露元数据", () => {
    const session = createSoftBodyRuntimeSession(physicsWith([softBall(), clothFlag()]));
    expect(session.readout("missing")).toBeUndefined();
    expect(session.entries.map(entry => entry.id)).toEqual(["ball-a", "flag-a"]);
    expect(session.entries.map(entry => entry.kind)).toEqual(["soft-body", "cloth"]);
  });
});
