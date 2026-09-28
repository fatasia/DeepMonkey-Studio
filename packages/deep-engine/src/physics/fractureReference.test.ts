import { describe, expect, it } from "vitest";
import { buildPreFracture, FractureLedger, momentumResidual, planTotalMass } from "./fractureReference.js";

const SPEC = {
  min: [0, 0, 0],
  max: [0.6, 0.4, 0.4],
  divisions: [3, 2, 2],
  jitter: 0.2,
  seed: 20260927,
  density: 2700,
  cohesionMin: 50,
  cohesionMax: 120,
} as const;

describe("buildPreFracture 构造合同", () => {
  it("拒绝非法输入", () => {
    expect(() => buildPreFracture({ ...SPEC, divisions: [0, 2, 2] })).toThrow(/divisions/);
    expect(() => buildPreFracture({ ...SPEC, max: [-0.1, 0.4, 0.4] })).toThrow(/max must be > min/);
    expect(() => buildPreFracture({ ...SPEC, jitter: 0.5 })).toThrow(/jitter/);
    expect(() => buildPreFracture({ ...SPEC, density: 0 })).toThrow(/density/);
    expect(() => buildPreFracture({ ...SPEC, cohesionMin: 200 })).toThrow(/cohesion range/);
  });

  it("胞元数、体积守恒与质量簿记", () => {
    const plan = buildPreFracture(SPEC);
    expect(plan.pieces.length).toBe(3 * 2 * 2);
    const boxVolume = 0.6 * 0.4 * 0.4;
    const totalVolume = plan.pieces.reduce((s, p) => s + p.volume, 0);
    expect(Math.abs(totalVolume - boxVolume)).toBeLessThan(1e-12);
    expect(Math.abs(planTotalMass(plan) - boxVolume * SPEC.density)).toBeLessThan(1e-9);
    for (const piece of plan.pieces) {
      expect(piece.volume).toBeGreaterThan(0);
      expect(piece.mass).toBeCloseTo(piece.volume * SPEC.density, 12);
      expect(piece.aabbMax[0]).toBeGreaterThan(piece.aabbMin[0]);
    }
  });

  it("连接数 = Σ(+x/+y/+z 邻居),强度 = 面积 × 韧度且在范围内", () => {
    const plan = buildPreFracture(SPEC);
    const expected = (3 - 1) * 2 * 2 + 3 * (2 - 1) * 2 + 3 * 2 * (2 - 1);
    expect(plan.connections.length).toBe(expected);
    for (const conn of plan.connections) {
      expect(conn.area).toBeGreaterThan(0);
      expect(conn.strengthJoules).toBeGreaterThanOrEqual(conn.area * SPEC.cohesionMin - 1e-12);
      expect(conn.strengthJoules).toBeLessThanOrEqual(conn.area * SPEC.cohesionMax + 1e-12);
      expect(conn.pieceA).not.toBe(conn.pieceB);
    }
  });

  it("切割面单调:同轴相邻界面严格递增(抖动不交叉)", () => {
    const plan = buildPreFracture({ ...SPEC, jitter: 0.49 });
    for (const piece of plan.pieces) {
      expect(piece.aabbMax[0] - piece.aabbMin[0]).toBeGreaterThan(0.3 * (0.6 / 3));
    }
  });
});

describe("确定性:同 seed 逐位一致,异 seed 发散", () => {
  it("同 seed 两次生成的计划完全一致", () => {
    const a = buildPreFracture(SPEC);
    const b = buildPreFracture(SPEC);
    expect(a.pieces).toEqual(b.pieces);
    expect(a.connections).toEqual(b.connections);
  });

  it("异 seed 的切割面/强度不同", () => {
    const a = buildPreFracture(SPEC);
    const b = buildPreFracture({ ...SPEC, seed: 42 });
    const differs = a.pieces.some((p, i) => p.aabbMin.some((v, axis) => v !== b.pieces[i].aabbMin[axis]))
      || a.connections.some((c, i) => c.strengthJoules !== b.connections[i].strengthJoules);
    expect(differs).toBe(true);
  });
});

describe("FractureLedger 断裂簿记", () => {
  it("能量累计到强度才断裂;已断裂连接幂等", () => {
    const plan = buildPreFracture({ ...SPEC, jitter: 0, cohesionMin: 100, cohesionMax: 100 });
    const ledger = new FractureLedger(plan);
    const conn = plan.connections[0];
    const half = conn.strengthJoules / 2;
    expect(ledger.applyImpact(conn.id, half)).toBeNull();
    expect(ledger.intactCount).toBe(plan.connections.length);
    expect(ledger.applyImpact(conn.id, half * 0.9)).toBeNull();
    const event = ledger.applyImpact(conn.id, half);
    expect(event).not.toBeNull();
    expect(event?.connectionId).toBe(conn.id);
    // 记录的是真实累计吸收(含过冲),不是钳到强度值——过冲幅度是求解切片的输入。
    expect(event?.absorbedJoules).toBeGreaterThanOrEqual(conn.strengthJoules);
    expect(ledger.intactCount).toBe(plan.connections.length - 1);
    expect(ledger.isBroken(conn.id)).toBe(true);
    expect(ledger.applyImpact(conn.id, 1e6)).toBeNull();
    expect(ledger.events.length).toBe(1);
  });

  it("非法输入抛错", () => {
    const ledger = new FractureLedger(buildPreFracture(SPEC));
    expect(() => ledger.applyImpact(-1, 1)).toThrow(/out of range/);
    expect(() => ledger.applyImpact(9999, 1)).toThrow(/out of range/);
    expect(() => ledger.applyImpact(0, -1)).toThrow(/energy/);
  });

  it("断裂冲量拆分总动量守恒(残差为零向量)", () => {
    const ledger = new FractureLedger(buildPreFracture(SPEC));
    const deltas = [
      ledger.breakImpulseDeltas(0, [3, -4, 5]),
      ledger.breakImpulseDeltas(1, [-1.5, 2, 0]),
    ];
    expect(momentumResidual(deltas)).toEqual([0, 0, 0]);
    expect(() => ledger.breakImpulseDeltas(0, [Number.NaN, 0, 0])).toThrow(/finite/);
  });
});
