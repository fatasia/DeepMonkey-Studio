import { describe, expect, it } from "vitest";
import { WORLD_LIMITS, WorldApiContractError, canonicalJson, type WorldSnapshot } from "@bim-studio/contracts";
import { HeadlessWorld } from "./headlessWorld.js";
import { loadRapier, type Rapier, type World } from "./rapierRuntime.js";
import { WorldRuntimeError, sha256Hex } from "./worldMath.js";
import { WorldSessionManager, WorldSessionError } from "./worldSessions.js";

/** 代码审查回归：伪造快照、数值量级、step 原子性与时间预算。 */

const body = (id: string, position: [number, number, number], extra: Record<string, unknown> = {}, scale = 1) => ({
  modelId: id, name: id, kind: "box", visible: true,
  transform: { position: { x: position[0], y: position[1], z: position[2] }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: scale, y: scale, z: scale } },
  physics: { type: "dynamic", mass: 1, friction: 0.5, restitution: 0, ...extra },
});
const scene = (primitives: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, id: "s", models: [], primitives, ...extra });
const two = () => scene([body("a", [0, 3, 0], {}, 0.3), body("b", [2, 3, 0], {}, 0.3)]);

async function legitSnapshot(): Promise<WorldSnapshot> {
  const world = await HeadlessWorld.reset({ seed: 1, scene: two() });
  world.step({ ticks: 5 });
  const snapshot = world.snapshot();
  world.dispose();
  return snapshot;
}

/** 复现脚本 e2b 的固化：改写 Rapier 字节后重算 sha256 与 snapshotHash（二者无密钥，客户端可算）。 */
async function forge(snapshot: WorldSnapshot, mutate: (rapier: Rapier, world: World, handleOf: (id: string) => number) => void): Promise<WorldSnapshot> {
  const rapier = await loadRapier();
  const world = rapier.World.restoreSnapshot(new Uint8Array(Buffer.from(snapshot.physics.data, "base64")));
  mutate(rapier, world, (id) => snapshot.objects.find((object) => object.id === id)!.handle as number);
  const bytes = Buffer.from(world.takeSnapshot());
  world.free();
  const { snapshotHash: _stale, ...rest } = { ...snapshot, physics: { encoding: "base64" as const, data: bytes.toString("base64"), byteLength: bytes.length, sha256: sha256Hex(bytes) } };
  return { ...rest, snapshotHash: sha256Hex(canonicalJson(rest)) };
}

const rejectsCorrupt = (promise: Promise<unknown>, pattern: RegExp) => expect(promise).rejects.toThrow(pattern);

describe("审查#1 Critical：伪造快照不能绕过资源上限", () => {
  it("给合法刚体挂 2500 个额外碰撞体（哈希重算）→ 在 restore 就被拒绝，且无需步进", async () => {
    const snapshot = await legitSnapshot();
    const forged = await forge(snapshot, (rapier, world, handleOf) => {
      const rigid = world.getRigidBody(handleOf("a"));
      for (let index = 0; index < 2500; index += 1) world.createCollider(rapier.ColliderDesc.ball(2 + (index % 7) * 0.01), rigid);
    });
    const started = performance.now();
    await rejectsCorrupt(HeadlessWorld.restore(forged), /碰撞体数 \d+ 与刚体数 \d+ 不一致/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("额外刚体 / 关节 / 放大碰撞体 / 附加求解迭代 / 失常速度 一律拒绝", async () => {
    const snapshot = await legitSnapshot();
    await rejectsCorrupt(HeadlessWorld.restore(await forge(snapshot, (rapier, world) => {
      const extra = world.createRigidBody(rapier.RigidBodyDesc.dynamic());
      world.createCollider(rapier.ColliderDesc.ball(0.5), extra);
    })), /刚体数/);
    await rejectsCorrupt(HeadlessWorld.restore(await forge(snapshot, (rapier, world, handleOf) => {
      world.createImpulseJoint(rapier.JointData.fixed({ x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }), world.getRigidBody(handleOf("a")), world.getRigidBody(handleOf("b")), true);
    })), /关节/);
    await rejectsCorrupt(HeadlessWorld.restore(await forge(snapshot, (_rapier, world, handleOf) => {
      world.getRigidBody(handleOf("a")).collider(0).setHalfExtents({ x: 400, y: 400, z: 400 });
    })), /碰撞体与对象表不一致/);
    await rejectsCorrupt(HeadlessWorld.restore(await forge(snapshot, (_rapier, world, handleOf) => {
      world.getRigidBody(handleOf("a")).setAdditionalSolverIterations(5000);
    })), /非默认的求解设置/);
    await rejectsCorrupt(HeadlessWorld.restore(await forge(snapshot, (_rapier, world, handleOf) => {
      world.getRigidBody(handleOf("a")).setLinvel({ x: 1e300, y: 0, z: 0 }, true);
    })), /量级失常/);
  });

  it("伪造的求解迭代数/CCD 子步被默认值覆盖：恢复后的世界与合法快照的世界逐位一致", async () => {
    const snapshot = await legitSnapshot();
    const forged = await forge(snapshot, (_rapier, world) => {
      world.integrationParameters.numSolverIterations = 5000;
      world.integrationParameters.maxCcdSubsteps = 5000;
    });
    const honest = await HeadlessWorld.restore(snapshot);
    const restored = await HeadlessWorld.restore(forged);
    expect(restored.step({ ticks: 30 }).observation.stateHash).toBe(honest.step({ ticks: 30 }).observation.stateHash);
    honest.dispose();
    restored.dispose();
  });

  it("对象表层面的上限：物体数、名称长度、重力、缩放、重复 id / 句柄都在合同层被拒绝", async () => {
    const snapshot = await legitSnapshot();
    const mutate = (change: (copy: WorldSnapshot) => void) => {
      const copy = structuredClone(snapshot);
      change(copy);
      const { snapshotHash: _stale, ...rest } = copy;
      return { ...rest, snapshotHash: sha256Hex(canonicalJson(rest)) };
    };
    const reject = (value: unknown) => expect(HeadlessWorld.restore(value)).rejects.toThrow(WorldApiContractError);
    await reject(mutate((copy) => { copy.objects = Array.from({ length: WORLD_LIMITS.maxObjects + 1 }, (_, index) => ({ ...copy.objects[0]!, id: `o${index}` })); }));
    await reject(mutate((copy) => { copy.objects[0]!.name = "x".repeat(WORLD_LIMITS.maxNameLength + 1); }));
    await reject(mutate((copy) => { copy.gravity = [0, -1e308, 0]; }));
    await reject(mutate((copy) => { copy.objects[0]!.transform.scale = [1e9, 1, 1]; }));
    await reject(mutate((copy) => { copy.objects[1]!.id = copy.objects[0]!.id; }));
    await reject(mutate((copy) => { copy.objects[1]!.handle = copy.objects[0]!.handle; }));
    await reject(mutate((copy) => { copy.objects[0]!.collider = { shape: "ball", radius: 1e6 }; }));
    await reject(mutate((copy) => { copy.objects[0]!.body.mass = 0; }));
    await reject(mutate((copy) => { copy.groundHandle = null; }));
  });
});

describe("审查#1/#2：单次 step 的时间预算", () => {
  const clock = (stepMs: number) => { let now = 0; return () => (now += stepMs); };

  it("超预算：按 tick 粒度中止，世界作废；作废后一切操作被拒绝", async () => {
    const world = await HeadlessWorld.reset({ seed: 1, scene: two() }, { stepBudgetMs: 5, now: clock(3) });
    expect(() => world.step({ ticks: 10 })).toThrow(/时间预算/);
    expect(world.isFaulted).toBe(true);
    expect(world.tick).toBe(2);
    for (const run of [() => world.step({ ticks: 1 }), () => world.observe({}), () => world.snapshot()]) expect(run).toThrow(/作废/);
    world.dispose();
  });

  it("预算内正常完成，不受时钟影响（确定性结果与无预算一致）", async () => {
    const budgeted = await HeadlessWorld.reset({ seed: 1, scene: two() }, { stepBudgetMs: 1_000_000, now: clock(1) });
    const plain = await HeadlessWorld.reset({ seed: 1, scene: two() });
    expect(budgeted.step({ ticks: 60 }).observation.stateHash).toBe(plain.step({ ticks: 60 }).observation.stateHash);
    budgeted.dispose();
    plain.dispose();
  });

  it("会话层：作废的世界在下一次访问时被回收并给出可操作原因", async () => {
    const sessions = new WorldSessionManager({ limits: { stepBudgetMs: -1 } });
    const owner = { projectId: "p", principal: "u" };
    const { info } = await sessions.create(owner, { seed: 1, scene: two() });
    expect(() => sessions.get(owner, info.worldId).step({ ticks: 3 })).toThrow(WorldRuntimeError);
    await expect((async () => sessions.get(owner, info.worldId))()).rejects.toThrow(/作废并关闭/);
    expect(sessions.size).toBe(0);
  });

  it("求解后出现失常量级（极小质量 + 最大冲量）→ 世界作废而不是返回 NaN/null 观测", async () => {
    const world = await HeadlessWorld.reset({ seed: 1, scene: scene([body("light", [0, 3, 0], { mass: WORLD_LIMITS.minMass }, 0.3)]) });
    const action = { physics: [{ type: "apply-impulse", objectId: "light", impulse: [WORLD_LIMITS.maxAbsImpulse, 0, 0] }] };
    expect(() => world.step({ ticks: 12, action })).toThrow(/量级失常|非有限/);
    expect(world.isFaulted).toBe(true);
    world.dispose();
  });
});

describe("审查#2/#5：数值量级与刚体参数（reset 与 step 同一口径）", () => {
  const reset = (value: unknown) => HeadlessWorld.reset({ seed: 1, scene: value });

  it("reset 拒绝越界的缩放/质量/位置/重力/摩擦/碰撞体尺寸（复现 e1/e3 的 1e308 与 scale 200）", async () => {
    await expect(reset(scene([body("a", [0, 1, 0], {}, 200)]))).rejects.toThrow(/scale/);
    await expect(reset(scene([body("a", [0, 1, 0], {}, 0.001)]))).rejects.toThrow(/scale/);
    await expect(reset(scene([body("a", [0, 1, 0], { mass: 0 })]))).rejects.toThrow(/mass/);
    await expect(reset(scene([body("a", [0, 1, 0], { mass: -5 })]))).rejects.toThrow(/mass/);
    await expect(reset(scene([body("a", [0, 1e308, 0])]))).rejects.toThrow(/position/);
    await expect(reset(scene([body("a", [0, 1, 0])], { physics: { gravity: { x: 0, y: -1e308, z: 0 } } }))).rejects.toThrow(/gravity/);
    await expect(reset(scene([body("a", [0, 1, 0], { friction: -1 })]))).rejects.toThrow(/friction/);
    await expect(reset(scene([body("a", [0, 1, 0], { initialLinearVelocity: { x: 1e300, y: 0, z: 0 } })]))).rejects.toThrow(/initialLinearVelocity/);
    const huge = { ...body("m", [0, 1, 0], { collider: { kind: "primitive", primitive: { shape: "cuboid", halfExtents: { x: 100, y: 100, z: 100 } } } }, 10), kind: undefined };
    await expect(HeadlessWorld.reset({ seed: 1, scene: { ...scene([]), models: [huge] } })).rejects.toThrow(/碰撞体尺寸/);
  });

  it("名称被截断到上限；非动态体的越界质量归一为 1，之后改成 dynamic 仍能正常下落", async () => {
    const world = await reset(scene([{ ...body("fixed-box", [0, 3, 0], { type: "fixed", mass: 0 }, 0.3), name: "n".repeat(10_000) }]));
    expect(world.snapshot().objects[0]).toMatchObject({ name: "n".repeat(WORLD_LIMITS.maxNameLength), body: { mass: 1 } });
    world.step({ ticks: 1, action: { physics: [{ type: "set-body", objectId: "fixed-box", body: { type: "dynamic" } }] } });
    const y = world.step({ ticks: 30 }).observation.bodies?.[0]?.position[1] ?? 3;
    expect(y).toBeLessThan(3);
    world.dispose();
  });

  it("step 的冲量/速度/位置/缩放越界在任何状态变更前被拒绝（1e308 复现）", async () => {
    const world = await reset(two());
    const before = world.snapshot();
    const bad = (action: object) => expect(() => world.step({ ticks: 1, action })).toThrow();
    bad({ physics: [{ type: "apply-impulse", objectId: "a", impulse: [1e308, 1e308, 1e308] }] });
    bad({ physics: [{ type: "set-linear-velocity", objectId: "a", velocity: [1e300, 0, 0] }] });
    bad({ physics: [{ type: "set-body", objectId: "a", body: { type: "dynamic", mass: 0 } }] });
    const transform = (extra: object) => ({ commands: [{ id: "t", type: "object.set-transform", target: { kind: "object", sceneId: "s", objectId: "a" }, ...extra }] });
    bad(transform({ position: [0, 1e9, 0] }));
    bad(transform({ rotation: [1e9, 0, 0] }));
    expect(world.tick).toBe(before.tick);
    expect(world.snapshot().snapshotHash).toBe(before.snapshotHash);
    world.dispose();
  });
});

describe("审查#4/#9：step 原子性与 JSON 入口", () => {
  it("20 万层嵌套的事件 data 在改动世界之前被拒绝：tick、traceHash、状态均不变（复现 e3）", async () => {
    const world = await HeadlessWorld.reset({ seed: 1, scene: two() });
    world.step({ ticks: 3 });
    const before = world.snapshot();
    const depth = 200_000;
    const parsed = JSON.parse(`{"ticks":1,"action":{"events":[{"name":"e","data":${"[".repeat(depth)}${"]".repeat(depth)}}]}}`);
    expect(() => world.step(parsed)).toThrow(WorldApiContractError);
    expect(world.tick).toBe(before.tick);
    expect(world.snapshot().snapshotHash).toBe(before.snapshotHash);
    world.dispose();
  });

  it("事件 data 的节点数/字节数上限、__proto__ 键、非纯 JSON 都被拒绝；合法 data 可往返", async () => {
    const world = await HeadlessWorld.reset({ seed: 1, scene: two() });
    const send = (data: unknown) => world.step({ ticks: 1, action: { events: [{ name: "e", data }] } });
    expect(() => send("x".repeat(WORLD_LIMITS.maxEventDataBytes + 1))).toThrow(/字节/);
    expect(() => send(Array.from({ length: WORLD_LIMITS.maxEventDataNodes + 1 }, () => 1))).toThrow(/节点数/);
    expect(() => send(JSON.parse('{"a":{"__proto__":{"x":1}}}'))).toThrow(/__proto__/);
    expect(() => send({ when: new Date() })).toThrow(/纯 JSON/);
    expect(() => send({ n: Number.POSITIVE_INFINITY })).toThrow(/非有限/);
    expect(world.tick).toBe(0);
    const ok = send({ nested: { list: [1, "two", null, true] } });
    expect(ok.observation.events?.[0]).toMatchObject({ type: "business.event", data: { nested: { list: [1, "two", null, true] } } });
    world.dispose();
  });

  it("命令里夹带 __proto__ 同样被入口拒绝", async () => {
    const world = await HeadlessWorld.reset({ seed: 1, scene: two() });
    const command = JSON.parse('{"id":"d","type":"data.apply","target":{"kind":"object","sceneId":"s","objectId":"a"},"values":{"__proto__":{"x":1}},"timestamp":"2026-10-03T00:00:00Z"}');
    expect(() => world.step({ ticks: 1, action: { commands: [command] } })).toThrow(/__proto__/);
    world.dispose();
  });
});

describe("审查#3：会话配额按用户统一、绝对存活期、快照签发记录", () => {
  const limits = { maxWorlds: 8, maxWorldsPerPrincipal: 2, idleTimeoutMs: 1_000, maxLifetimeMs: 5_000 };
  const request = { seed: 1, scene: two() };

  it("同一用户跨项目合计受限；换项目不能绕过", async () => {
    const sessions = new WorldSessionManager({ limits });
    await sessions.create({ projectId: "p1", principal: "u1" }, request);
    await sessions.create({ projectId: "p2", principal: "u1" }, request);
    await expect(sessions.create({ projectId: "p3", principal: "u1" }, request)).rejects.toThrow(WorldSessionError);
    await sessions.create({ projectId: "p1", principal: "u2" }, request);
    sessions.dispose();
  });

  it("持续访问也无法超过绝对存活期；到期后立即不可用并释放配额", async () => {
    const clock = { t: 0 };
    const sessions = new WorldSessionManager({ limits, now: () => clock.t });
    const owner = { projectId: "p", principal: "u" };
    const { info } = await sessions.create(owner, request);
    for (let step = 0; step < 5; step += 1) { clock.t += 900; sessions.get(owner, info.worldId); }
    clock.t += 900;
    await expect((async () => sessions.get(owner, info.worldId))()).rejects.toThrow(/存活期/);
    expect(sessions.size).toBe(0);
  });

  it("noteSnapshotIssued/wasSnapshotIssued：有界记忆，区分本服务签发与客户端自带", () => {
    const sessions = new WorldSessionManager();
    sessions.noteSnapshotIssued("h0");
    expect(sessions.wasSnapshotIssued("h0")).toBe(true);
    expect(sessions.wasSnapshotIssued("other")).toBe(false);
    for (let index = 1; index <= 300; index += 1) sessions.noteSnapshotIssued(`h${index}`);
    expect(sessions.wasSnapshotIssued("h0")).toBe(false);
    expect(sessions.wasSnapshotIssued("h300")).toBe(true);
  });
});
