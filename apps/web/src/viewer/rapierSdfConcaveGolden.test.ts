import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSdfCollisionMesh, sdfColliderPayloadToGrid } from "@bim-studio/deep-engine/physics";

/**
 * F6 凹体碰撞黄金案例(Web 侧,T17 家族口径:同输入重复运行逐位一致)。
 * 场景参数与 Native `packages/deep-engine-native/src/native_physics_sdf_golden_tests.rs`
 * 逐项对齐;改任何参数必须两侧同步,否则跨端配对数据作废。
 *
 * SDF 网格体经 `sdfCollisionBridge`(Freudenthal 六四面体零等值面提取)变成
 * Rapier trimesh collider(凹体仅 fixed);提取核与 Native Rust 镜像逐位同构
 * (physics_sdf_l_fixture.json SHA-256 对拍)。小球滚入凹槽与凸包幽灵厚度
 * 对照的语义见 Native 侧文件头。
 */

const SCENARIO = {
  ballRadius: 0.3,
  ballMass: 0.5,
  friction: 0.6,
  restitution: 0,
  gravity: { x: 0, y: -9.81, z: 0 },
  fixedStep: 1 / 60,
  rollSteps: 240,
  dropSteps: 90,
  rollStart: [2.5, 1.35, 0.5] as const,
  rollVelocity: [-0.3, 0, 0] as const,
  dropStart: [2.0, 2.5, 0.5] as const,
  gridOrigin: [-0.125, -0.125, -0.125] as const,
  gridCellSize: 0.25,
  gridDimensions: [16, 16, 8] as const,
} as const;

interface FixtureShape {
  distances: number[];
  expect: { triangleCount: number; vertexCount: string };
}

const FIXTURE_PATH = resolve(__dirname, "../../../../packages/deep-engine-native/src/physics_sdf_l_fixture.json");

function buildNotchTrimesh(): { vertices: Float32Array; indices: Uint32Array } {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureShape;
  const grid = sdfColliderPayloadToGrid({
    origin: SCENARIO.gridOrigin, cellSize: SCENARIO.gridCellSize,
    dimensions: SCENARIO.gridDimensions, distances: fixture.distances,
  });
  const mesh = extractSdfCollisionMesh(grid);
  return { vertices: mesh.positions, indices: mesh.indices };
}

type Quat = [number, number, number, number];
interface Pose { p: [number, number, number]; q: Quat; v: [number, number, number] }

type RapierModule = typeof import("@dimforge/rapier3d-compat").default;

function notchColliderDesc(kind: "sdf" | "hull", rapier: RapierModule): import("@dimforge/rapier3d-compat").ColliderDesc {
  if (kind === "sdf") {
    const trimesh = buildNotchTrimesh();
    return rapier.ColliderDesc.trimesh(trimesh.vertices, trimesh.indices)
      .setFriction(SCENARIO.friction).setRestitution(SCENARIO.restitution);
  }
  const corners: ReadonlyArray<readonly [number, number]> =
    [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
  const points = new Float32Array(corners.length * 6);
  corners.forEach(([x, y], index) => {
    points[index * 6] = x; points[index * 6 + 1] = y; points[index * 6 + 2] = 0;
    points[index * 6 + 3] = x; points[index * 6 + 4] = y; points[index * 6 + 5] = 1;
  });
  return rapier.ColliderDesc.convexHull(points)!
    .setFriction(SCENARIO.friction).setRestitution(SCENARIO.restitution);
}

async function runNotch(
  start: readonly [number, number, number],
  velocity: readonly [number, number, number] | null,
  steps: number,
  kind: "sdf" | "hull",
) {
  const rapier = (await import("@dimforge/rapier3d-compat")).default;
  await rapier.init();
  const world = new rapier.World({ ...SCENARIO.gravity });

  // body ids 字典序与 Native 一致:body-ball < body-ground < body-sdf(顺序仅影响创建序)。
  const ball = world.createRigidBody(
    rapier.RigidBodyDesc.dynamic().setTranslation(start[0], start[1], start[2]).setCcdEnabled(true),
  );
  if (velocity) ball.setLinvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, true);
  world.createCollider(
    rapier.ColliderDesc.ball(SCENARIO.ballRadius)
      .setMass(SCENARIO.ballMass).setFriction(SCENARIO.friction).setRestitution(SCENARIO.restitution),
    ball,
  );
  const ground = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0));
  world.createCollider(
    rapier.ColliderDesc.cuboid(5, 0.1, 5).setFriction(SCENARIO.friction).setRestitution(SCENARIO.restitution),
    ground,
  );
  const notch = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  world.createCollider(notchColliderDesc(kind, rapier), notch);

  const snapshot = (): Pose => {
    const t = ball.translation(), r = ball.rotation(), v = ball.linvel();
    return { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w], v: [v.x, v.y, v.z] };
  };
  const poses: Pose[] = [];
  for (let step = 0; step < steps; step += 1) {
    world.timestep = SCENARIO.fixedStep;
    world.step();
    poses.push(snapshot());
  }
  const finalPose = poses[poses.length - 1]!;
  world.free();
  return { poses, finalPose };
}

describe("Rapier Web SDF concave notch golden (F6)", () => {
  it("rolls the ball into the notch, makes real contact and repeats bit-exactly", async () => {
    const first = await runNotch(SCENARIO.rollStart, SCENARIO.rollVelocity, SCENARIO.rollSteps, "sdf");
    const repeat = await runNotch(SCENARIO.rollStart, SCENARIO.rollVelocity, SCENARIO.rollSteps, "sdf");
    expect(repeat.poses).toEqual(first.poses);

    const { p } = first.finalPose;
    const [x, y, z] = p;
    expect(x, `ball must settle inside the notch, got x=${x}`).toBeGreaterThan(1.05);
    expect(x, `ball must settle inside the notch, got x=${x}`).toBeLessThan(2.3);
    expect(Math.abs(y - (1 + SCENARIO.ballRadius)), `ball must rest on the groove floor, got y=${y}`)
      .toBeLessThan(0.03);
    expect(Math.abs(z - 0.5), "ball must stay near the z=0.5 plane (facet bias bounded)").toBeLessThan(0.12);
  });

  it("measures the convex-hull ghost thickness against the SDF contact", async () => {
    // 首次接触 = 竖直速度首次偏离自由落体预测(Rapier 半隐式欧拉逐步精确)。
    const firstContactY = (poses: Pose[]): number => {
      const gDt = 9.81 * SCENARIO.fixedStep;
      for (const [step, pose] of poses.entries()) {
        const expectedVy = -gDt * (step + 1);
        if (Math.abs(pose.v[1] - expectedVy) > 0.02) return pose.p[1];
      }
      throw new Error("ball never made contact");
    };

    const hull = await runNotch(SCENARIO.dropStart, null, SCENARIO.dropSteps, "hull");
    const repeat = await runNotch(SCENARIO.dropStart, null, SCENARIO.dropSteps, "hull");
    expect(repeat.poses).toEqual(hull.poses);
    const sdf = await runNotch(SCENARIO.dropStart, null, SCENARIO.dropSteps, "sdf");

    const hullContact = firstContactY(hull.poses);
    const sdfContact = firstContactY(sdf.poses);
    const ghost = hullContact - sdfContact;
    expect(ghost, `ghost thickness must be ≈1.124 m, got ${ghost}`).toBeGreaterThan(1.0);
    expect(ghost, `ghost thickness must be ≈1.124 m, got ${ghost}`).toBeLessThan(1.25);

    const sdfEnd = sdf.finalPose.p;
    expect(sdfEnd[0], `SDF ball must stay in the notch, got x=${sdfEnd[0]}`).toBeGreaterThan(1.2);
    expect(sdfEnd[0], `SDF ball must stay in the notch, got x=${sdfEnd[0]}`).toBeLessThan(2.95);
    expect(Math.abs(sdfEnd[1] - (1 + SCENARIO.ballRadius))).toBeLessThan(0.05);
    const [hx, hy] = hull.finalPose.p;
    const escaped = hx > 3 + SCENARIO.ballRadius || hy < 0.9;
    expect(escaped, `hull ball must escape the notch, got x=${hx} y=${hy}`).toBe(true);
  });

  it("records per-step poses for the Web↔Native bitwise pairing", async () => {
    const run = await runNotch(SCENARIO.rollStart, SCENARIO.rollVelocity, SCENARIO.rollSteps, "sdf");
    const outputDirectory = resolve(__dirname, "../../../../test-output/f6-sdf-bridge");
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(
      resolve(outputDirectory, "web-sdf-notch-poses.json"),
      JSON.stringify({
        meta: {
          end: "web", rapier: "0.19.3", scenario: "sdf-concave-notch",
          ballRadius: SCENARIO.ballRadius, ballMass: SCENARIO.ballMass,
          friction: SCENARIO.friction, restitution: SCENARIO.restitution,
          gravity: [SCENARIO.gravity.x, SCENARIO.gravity.y, SCENARIO.gravity.z],
          fixedStepSeconds: SCENARIO.fixedStep, steps: SCENARIO.rollSteps,
          rollStart: SCENARIO.rollStart, rollVelocity: SCENARIO.rollVelocity,
          grid: { origin: SCENARIO.gridOrigin, cellSize: SCENARIO.gridCellSize, dimensions: SCENARIO.gridDimensions },
          bridge: "sdfCollisionBridge (Freudenthal MT, f32 bitwise, fixture-paired)",
        },
        poses: run.poses,
      }),
    );
    expect(run.poses).toHaveLength(SCENARIO.rollSteps);
  });
});
