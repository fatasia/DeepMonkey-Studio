import { describe, expect, it } from "vitest";
import { WorldApiContractError, canonicalJson, type WorldObservation, type WorldSnapshot } from "@bim-studio/contracts";
import { HeadlessWorld } from "./headlessWorld.js";
import { WorldRuntimeError, sha256Hex } from "./worldMath.js";

const SCENE_ID = "scene-test";

function primitive(id: string, kind: string, position: [number, number, number], scale: number, physics: Record<string, unknown>) {
  return {
    modelId: id, name: id, kind, color: "#cccccc", visible: true, opacity: 1,
    transform: { position: { x: position[0], y: position[1], z: position[2] }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: scale, y: scale, z: scale } },
    physics: { mass: 1, friction: 0.6, restitution: 0.1, ...physics },
  };
}

/** 三个箱子竖直堆叠 + 一个球从侧上方落下：有接触、有碰撞、有滚动，足以暴露任何非确定性。 */
function scene(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, id: SCENE_ID, projectId: "p", name: "t", models: [],
    physics: { enabled: true, playing: true, gravity: { x: 0, y: -9.81, z: 0 } },
    primitives: [
      primitive("box-a", "box", [0, 0.25, 0], 0.25, { type: "dynamic" }),
      primitive("box-b", "box", [0.05, 0.8, 0], 0.25, { type: "dynamic" }),
      primitive("box-c", "box", [-0.05, 1.4, 0.02], 0.25, { type: "dynamic" }),
      primitive("ball", "sphere", [0.6, 2.4, 0], 0.3, { type: "dynamic", restitution: 0.4 }),
      primitive("wall", "box", [3, 0.5, 0], 0.5, { type: "fixed" }),
      primitive("marker", "box", [5, 1, 5], 0.1, { type: "none" }),
    ],
    ...extra,
  };
}

/** 键是累计 tick：调用恰好从该 tick 起步时附带对应 action（所有被比较的分段方案都在 tick 0 与 12 处有调用边界）。 */
const ACTIONS: Record<number, object> = {
  0: { physics: [{ type: "apply-impulse", objectId: "ball", impulse: [0.4, 0, 0.1] }] },
  12: { physics: [{ type: "set-linear-velocity", objectId: "box-a", velocity: [0.3, 0, 0] }], events: [{ name: "operator.nudge", data: { n: 1 } }] },
};

async function newWorld(seed = 7, options?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return HeadlessWorld.reset({ seed, scene: scene(extra), ...(options ? { options } : {}) });
}

/** 以给定的每次调用 tick 数序列推进；在累计 tick 命中 ACTIONS 键的那一次调用上附带 action。 */
function drive(world: HeadlessWorld, cadence: number[]): WorldObservation[] {
  const observations: WorldObservation[] = [];
  for (const ticks of cadence) {
    const action = ACTIONS[world.tick] ?? {};
    observations.push(world.step({ action, ticks }).observation);
  }
  return observations;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const repeat = (ticks: number, times: number) => new Array<number>(times).fill(ticks);

describe("HeadlessWorld：reset / observe", () => {
  it("初始观测：tick=0、含全部物体与地面接触通道，sensors 返回阶段 3 占位", async () => {
    const world = await newWorld();
    const observation = world.observe({ sensors: [{ id: "depth0", kind: "depth" }] });
    expect(observation).toMatchObject({ tick: 0, timeSeconds: 0, seed: 7, observationVersion: "1" });
    expect(observation.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(observation.bodies?.map((body) => body.id)).toEqual(["box-a", "box-b", "box-c", "ball", "wall", "marker"]);
    expect(observation.bodies?.find((body) => body.id === "marker")).toMatchObject({ bodyType: "none", position: [5, 1, 5], sleeping: false });
    expect(observation.sensors).toEqual({ depth0: { status: "unsupported", kind: "depth", reason: "reserved-for-stage-3" } });
    expect(world.observe({ channels: ["contacts"] }).bodies).toBeUndefined();
    world.dispose();
  });

  it("物体落地稳定：箱子停在地面之上，接触事件含 @ground 与行为层 collisionStart", async () => {
    const world = await newWorld();
    const first = world.step({ ticks: 120 }).observation;
    const resting = world.step({ ticks: 240 }).observation;
    const boxA = resting.bodies?.find((body) => body.id === "box-a");
    expect(boxA?.position[1]).toBeGreaterThan(0.2);
    expect(boxA?.position[1]).toBeLessThan(0.3);
    expect(first.contacts?.some((contact) => contact.started && (contact.a === "@ground" || contact.b === "@ground"))).toBe(true);
    const event = first.events?.find((item) => item.type === "object.event" && item.name === "collisionStart");
    expect(event).toMatchObject({ type: "object.event", target: { kind: "object", sceneId: SCENE_ID } });
    world.dispose();
  });

  it("无地面选项：物体持续下落", async () => {
    const world = await newWorld(1, { ground: false });
    const y = world.step({ ticks: 120 }).observation.bodies?.find((body) => body.id === "box-a")?.position[1] ?? 0;
    expect(y).toBeLessThan(-5);
    world.dispose();
  });

  it("带刚体的模型必须声明 primitive 碰撞体，否则 fail-closed", async () => {
    const model = { ...primitive("m1", "box", [0, 1, 0], 1, { type: "dynamic" }), kind: undefined };
    await expect(HeadlessWorld.reset({ seed: 1, scene: scene({ models: [model] }) })).rejects.toThrow(WorldRuntimeError);
    const ok = { ...model, physics: { ...model.physics, collider: { kind: "primitive", primitive: { shape: "cuboid", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } } } };
    const world = await HeadlessWorld.reset({ seed: 1, scene: scene({ models: [ok] }) });
    expect(world.objectCount).toBe(7);
    world.dispose();
  });
});

describe("HeadlessWorld：确定性", () => {
  it("同 seed + 同 action 序列：逐 step 的 observation 与 traceHash 完全一致", async () => {
    const runs: Array<{ observations: WorldObservation[]; trace: string }> = [];
    for (let run = 0; run < 2; run += 1) {
      const world = await newWorld(42);
      const observations = drive(world, repeat(5, 48));
      runs.push({ observations, trace: world.snapshot().traceHash });
      world.dispose();
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(new Set(runs[0]!.observations.map((o) => o.stateHash)).size).toBeGreaterThan(10);
  });

  it("变帧率调用拆分不影响结果：1 次×60 = 60 次×1 = 不规则分段", async () => {
    const cadences = [[12, 48], [...repeat(1, 12), ...repeat(1, 48)], [1, 2, 3, 6, 7, 11, 13, 17], [6, 6, 20, 28]];
    const finals: WorldObservation[] = [];
    for (const cadence of cadences) {
      expect(sum(cadence)).toBe(60);
      const world = await newWorld(9);
      const observations = drive(world, cadence);
      finals.push(observations.at(-1)!);
      world.dispose();
    }
    for (const final of finals.slice(1)) {
      expect(final.stateHash).toBe(finals[0]!.stateHash);
      expect(final.bodies).toEqual(finals[0]!.bodies);
    }
  });

  it("seed 经 initialPositionJitter 生效：同 seed 一致、异 seed 不同；jitter=0 时 seed 不改变物理", async () => {
    const final = async (seed: number, jitter: number) => {
      const world = await newWorld(seed, { initialPositionJitter: jitter });
      const hash = drive(world, repeat(10, 12)).at(-1)!.bodies;
      world.dispose();
      return hash;
    };
    expect(await final(5, 0.05)).toEqual(await final(5, 0.05));
    expect(await final(5, 0.05)).not.toEqual(await final(6, 0.05));
    expect(await final(5, 0)).toEqual(await final(6, 0));
  });

  it("snapshot→restore 后继续 step 与不中断运行逐位一致（含 traceHash）", async () => {
    const original = await newWorld(11);
    drive(original, repeat(4, 10));
    const hashAtSnapshot = original.observe({}).stateHash;
    const snapshot = original.snapshot();
    const uninterrupted = drive(original, repeat(6, 20));
    const finalTrace = original.snapshot().traceHash;
    original.dispose();

    const restored = await HeadlessWorld.restore(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.tick).toBe(40);
    expect(restored.observe({}).stateHash).toBe(hashAtSnapshot);
    const resumed = drive(restored, repeat(6, 20));
    expect(resumed.map((o) => o.stateHash)).toEqual(uninterrupted.map((o) => o.stateHash));
    expect(resumed).toEqual(uninterrupted);
    expect(restored.snapshot().traceHash).toBe(finalTrace);
    restored.dispose();
  });

  it("restore 还原的世界立即与快照时刻的 stateHash 一致，并且可再次快照得到同一物理字节", async () => {
    const world = await newWorld(3);
    drive(world, repeat(5, 12));
    const before = world.observe({}).stateHash;
    const snapshot = world.snapshot();
    const restored = await HeadlessWorld.restore(snapshot);
    expect(restored.observe({}).stateHash).toBe(before);
    expect(restored.snapshot().physics.sha256).toBe(snapshot.physics.sha256);
    expect(restored.snapshot().snapshotHash).toBe(snapshot.snapshotHash);
    world.dispose();
    restored.dispose();
  });

  it("restore 后的动态变更（创建/删除/set-body）与不中断运行一致", async () => {
    const mutate = {
      commands: [{ id: "c1", type: "object.create-primitive", target: { kind: "object", sceneId: SCENE_ID, objectId: "extra" }, name: "extra", kind: "sphere", color: "#ff0000" },
        { id: "c2", type: "object.set-transform", target: { kind: "object", sceneId: SCENE_ID, objectId: "extra" }, position: [0.2, 3, 0], scale: [0.2, 0.2, 0.2] }],
      physics: [{ type: "set-body", objectId: "extra", body: { type: "dynamic", mass: 2 } }],
    };
    const a = await newWorld(8);
    drive(a, repeat(5, 6));
    const snapshot = a.snapshot();
    const run = (world: HeadlessWorld) => [world.step({ action: mutate, ticks: 30 }).observation, world.step({ ticks: 90 }).observation];
    const expected = run(a);
    const b = await HeadlessWorld.restore(snapshot);
    expect(run(b)).toEqual(expected);
    a.dispose();
    b.dispose();
  });
});

describe("HeadlessWorld：step 输入与原子性", () => {
  it("dt 必须是 1/60 的整数倍，否则报错且世界不前进", async () => {
    const world = await newWorld();
    expect(() => world.step({ dt: 0.02 })).toThrow(WorldApiContractError);
    expect(() => world.step({ dt: 0.005 })).toThrow(/正整数倍/);
    expect(world.tick).toBe(0);
    expect(world.step({ dt: 1 / 30 }).ticksAdvanced).toBe(2);
    expect(world.step({ dt: 0.5 }).tickAfter).toBe(32);
    world.dispose();
  });

  it("action 原子：后面的非法项使整条拒绝，世界状态与 tick 不变", async () => {
    const world = await newWorld();
    const before = world.observe({}).stateHash;
    const bad = { physics: [{ type: "apply-impulse", objectId: "box-a", impulse: [0, 5, 0] }, { type: "apply-impulse", objectId: "wall", impulse: [0, 1, 0] }] };
    expect(() => world.step({ action: bad, ticks: 10 })).toThrow(/只能作用于动态刚体/);
    expect(() => world.step({ action: { physics: [{ type: "apply-impulse", objectId: "ghost", impulse: [0, 1, 0] }] }, ticks: 1 })).toThrow(/物体不存在/);
    expect(world.tick).toBe(0);
    expect(world.observe({}).stateHash).toBe(before);
    world.dispose();
  });

  it("场景命令 IR：创建→摆位→刚体→落地；noop 命令如实标注；层级与跨场景被拒", async () => {
    const world = await newWorld(2);
    const target = (objectId: string, sceneId = SCENE_ID) => ({ kind: "object", sceneId, objectId });
    const result = world.step({
      ticks: 180,
      action: {
        commands: [
          { id: "c1", type: "object.create-primitive", target: target("probe"), name: "probe", kind: "box", color: "#00ff00" },
          { id: "c2", type: "object.set-transform", target: target("probe"), position: [-3, 2, 0], scale: [0.2, 0.2, 0.2] },
          { id: "c3", type: "material.set", target: target("probe"), patch: { roughness: 0.3 } },
          { id: "c4", type: "object.set-visibility", target: target("marker"), visible: false },
        ],
        physics: [{ type: "set-body", objectId: "probe", body: { type: "dynamic" } }],
      },
    });
    expect(result.commandResults.map((item) => item.status)).toEqual(["applied", "applied", "noop", "applied"]);
    const bodies = result.observation.bodies ?? [];
    expect(bodies.find((body) => body.id === "probe")?.position[1]).toBeLessThan(0.3);
    expect(bodies.find((body) => body.id === "marker")?.visible).toBe(false);
    expect(result.observation.contacts?.some((c) => c.a === "probe" || c.b === "probe")).toBe(true);

    const parent = { id: "p1", type: "object.set-parent", target: target("probe"), parentId: "wall" };
    expect(() => world.step({ ticks: 1, action: { commands: [parent] } })).toThrow(/扁平世界/);
    const foreign = { id: "p2", type: "object.set-visibility", target: target("probe", "other"), visible: true };
    expect(() => world.step({ ticks: 1, action: { commands: [foreign] } })).toThrow(/sceneId/);
    const rescale = { id: "p3", type: "object.set-transform", target: target("probe"), scale: [3, 3, 3] };
    expect(() => world.step({ ticks: 1, action: { commands: [rescale] } })).toThrow(/不支持改缩放/);
    expect(() => world.step({ ticks: 1, action: { commands: [{ id: "bad", type: "object.nope" }] } })).toThrow(/不是合法的场景命令/);

    world.step({ ticks: 1, action: { commands: [{ id: "d1", type: "object.delete-primitive", target: target("probe") }] } });
    expect(world.observe({}).bodies?.some((body) => body.id === "probe")).toBe(false);
    world.dispose();
  });

  it("kinematic 物体按 set-transform 被驱动并推动动态体", async () => {
    const world = await HeadlessWorld.reset({
      seed: 1,
      scene: { ...scene(), primitives: [primitive("pusher", "box", [-1, 0.25, 0], 0.25, { type: "kinematic" }), primitive("crate", "box", [0, 0.25, 0], 0.25, { type: "dynamic", friction: 0.1 })] },
    });
    for (let index = 0; index < 30; index += 1) {
      world.step({ ticks: 2, action: { commands: [{ id: `m${index}`, type: "object.set-transform", target: { kind: "object", sceneId: SCENE_ID, objectId: "pusher" }, position: [-1 + 0.05 * (index + 1), 0.25, 0] }] } });
    }
    const crate = world.observe({}).bodies?.find((body) => body.id === "crate");
    expect(crate?.position[0]).toBeGreaterThan(0.2);
    world.dispose();
  });
});

describe("HeadlessWorld：快照完整性", () => {
  async function snapshotAt30(): Promise<WorldSnapshot> {
    const world = await newWorld();
    world.step({ ticks: 30 });
    const snapshot = world.snapshot();
    world.dispose();
    return snapshot;
  }

  it("篡改物理字节、对象表或哈希均按 snapshot-corrupt 拒绝", async () => {
    const snapshot = await snapshotAt30();
    const data = Buffer.from(snapshot.physics.data, "base64");
    data[100] = (data[100] ?? 0) ^ 0xff;
    const flipped = { ...snapshot, physics: { ...snapshot.physics, data: data.toString("base64") } };
    await expect(HeadlessWorld.restore(flipped)).rejects.toThrow(/sha256/);
    const moved = structuredClone(snapshot);
    moved.objects[0]!.transform.position = [9, 9, 9];
    await expect(HeadlessWorld.restore(moved)).rejects.toThrow(/snapshotHash/);
    await expect(HeadlessWorld.restore({ ...snapshot, snapshotVersion: "2" })).rejects.toThrow(WorldApiContractError);
    const badHandle = structuredClone(snapshot);
    badHandle.objects[0]!.handle = 9999;
    const { snapshotHash: _stale, ...body } = badHandle;
    // 重新计算哈希，模拟"自洽但指向不存在刚体"的伪造快照：必须被句柄核验挡住。
    await expect(HeadlessWorld.restore({ ...body, snapshotHash: sha256Hex(canonicalJson(body)) })).rejects.toThrow(/刚体句柄无效/);
  });

  it("快照可 JSON 往返，且 restore 不依赖原世界仍然存活", async () => {
    const snapshot = await snapshotAt30();
    const restored = await HeadlessWorld.restore(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.tick).toBe(30);
    expect(restored.sceneId).toBe(SCENE_ID);
    expect(restored.step({ ticks: 6 }).tickAfter).toBe(36);
    restored.dispose();
  });
});
