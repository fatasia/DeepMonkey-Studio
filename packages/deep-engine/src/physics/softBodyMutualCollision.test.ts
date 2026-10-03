import { describe, expect, it } from "vitest";
import { createSoftBodyRuntimeSession, type SoftBodyRuntimeSession } from "./softBodyRuntimeHost.js";
import { fingerprintFloat64 } from "./physicsTypes.js";
import type { DynamicPhysicsRuntime, DynamicSoftBodyRuntime } from "../runtimePackage/dynamicSceneRuntime.js";

const GRAVITY = [0, -9.81, 0] as const;
const RADIUS = 0.02; // 接触距离 2r = 0.04 ≤ spacing 0.05。
const TOTAL_TICKS = 200;
const WINDOW_FROM = 140;

/** 两块水平布上下叠置(间距始终 < 2r 需靠下落接触),上方布落到下方布上。 */
function clothBody(id: string, originY: number, seed: number): DynamicSoftBodyRuntime {
  return {
    id, kind: "cloth", columns: 10, rows: 10, spacing: 0.05, mass: 0.02,
    compliance: 0, damping: 0.01, perturbation: 0.006, seed,
    origin: [0, originY, 0], substeps: 8,
    pinned: [],
  } as DynamicSoftBodyRuntime;
}

function runtimeWithBodies(bodies: DynamicSoftBodyRuntime[]): DynamicPhysicsRuntime {
  return { gravity: GRAVITY, bodies: [], softBodies: bodies } as unknown as DynamicPhysicsRuntime;
}

/** 跨集合最小粒子距离(会话两个 body 各一块布)。 */
function minCrossDistance(session: SoftBodyRuntimeSession): number {
  const [idA, idB] = session.entries.map(entry => entry.id);
  const a = session.readout(idA!)!; const b = session.readout(idB!)!;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < a.length; i += 3) {
    for (let j = 0; j < b.length; j += 3) {
      const dx = a[i]! - b[j]!; const dy = a[i + 1]! - b[j + 1]!; const dz = a[i + 2]! - b[j + 2]!;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < min) min = d;
    }
  }
  return min;
}

function sessionFingerprint(session: SoftBodyRuntimeSession): string {
  const parts: string[] = [];
  for (const entry of session.entries) parts.push(fingerprintFloat64(session.readout(entry.id)!));
  return parts.join(":");
}

describe("跨软体互碰构造合同", () => {
  it("拒绝非法半径、四面体软体、substeps 不一致与 2r > spacing", () => {
    expect(() => createSoftBodyRuntimeSession(runtimeWithBodies([clothBody("a", 1, 1), clothBody("b", 0.6, 2)]),
      { mutualCollisionRadius: 0 })).toThrow(/mutualCollisionRadius/);
    const tetBody = {
      id: "tet", kind: "soft-body", positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
      tets: [[0, 1, 2, 3]], mass: 1, complianceDistance: 0, complianceVolume: 0,
      damping: 0, pinned: [], substeps: 4,
    } as unknown as DynamicSoftBodyRuntime;
    expect(() => createSoftBodyRuntimeSession(runtimeWithBodies([tetBody]), { mutualCollisionRadius: RADIUS })).toThrow(/cloth/);
    const fast = clothBody("fast", 1, 1); const slow = { ...clothBody("slow", 0.6, 2), substeps: 6 };
    expect(() => createSoftBodyRuntimeSession(runtimeWithBodies([fast, slow]), { mutualCollisionRadius: RADIUS })).toThrow(/substeps/);
    expect(() => createSoftBodyRuntimeSession(runtimeWithBodies([clothBody("a", 1, 1), clothBody("b", 0.6, 2)]),
      { mutualCollisionRadius: 0.03 })).toThrow(/spacing/);
  });
});

describe("互碰有效性:双布叠置窗口门", () => {
  it("禁用负控:上方布落到下方布内部(跨集最小距离 < 2r)", () => {
    const session = createSoftBodyRuntimeSession(runtimeWithBodies([clothBody("top", 1, 11), clothBody("bottom", 0.6, 22)]));
    let min = Number.POSITIVE_INFINITY;
    for (let t = 0; t < TOTAL_TICKS; t += 1) {
      session.step();
      if (t >= WINDOW_FROM) min = Math.min(min, minCrossDistance(session));
    }
    expect(min).toBeLessThan(2 * RADIUS);
  });

  it("启用:窗口内跨集最小距离 ≥ 0.9·2r,拉伸门保持,开关真实生效", () => {
    const session = createSoftBodyRuntimeSession(runtimeWithBodies([clothBody("top", 1, 11), clothBody("bottom", 0.6, 22)]),
      { mutualCollisionRadius: RADIUS });
    let min = Number.POSITIVE_INFINITY;
    for (let t = 0; t < TOTAL_TICKS; t += 1) {
      session.step();
      if (t >= WINDOW_FROM) min = Math.min(min, minCrossDistance(session));
    }
    expect(min).toBeGreaterThanOrEqual(0.9 * 2 * RADIUS);
    const plain = createSoftBodyRuntimeSession(runtimeWithBodies([clothBody("top", 1, 11), clothBody("bottom", 0.6, 22)]));
    for (let t = 0; t < TOTAL_TICKS; t += 1) plain.step();
    expect(sessionFingerprint(session)).not.toBe(sessionFingerprint(plain));
  });

  it("确定性:双跑逐位一致,快照回放逐位一致", () => {
    const a = createSoftBodyRuntimeSession(runtimeWithBodies([clothBody("top", 1, 11), clothBody("bottom", 0.6, 22)]),
      { mutualCollisionRadius: RADIUS });
    const b = createSoftBodyRuntimeSession(runtimeWithBodies([clothBody("top", 1, 11), clothBody("bottom", 0.6, 22)]),
      { mutualCollisionRadius: RADIUS });
    for (let t = 0; t < 100; t += 1) { a.step(); b.step(); }
    expect(sessionFingerprint(a)).toBe(sessionFingerprint(b));
    const snapshot = a.capture();
    a.restore(snapshot);
    for (let t = 0; t < 50; t += 1) a.step();
    for (let t = 0; t < 50; t += 1) b.step();
    expect(sessionFingerprint(a)).toBe(sessionFingerprint(b));
  });
});
