import { describe, expect, it } from "vitest";
import { WorldSessionError, WorldSessionManager, type WorldOwner } from "./worldSessions.js";

const alice: WorldOwner = { projectId: "p1", principal: "alice" };
const bob: WorldOwner = { projectId: "p1", principal: "bob" };
const aliceOtherProject: WorldOwner = { projectId: "p2", principal: "alice" };

const reset = (seed = 1, count = 1) => ({
  seed,
  scene: {
    schemaVersion: 1, id: "s", models: [],
    primitives: Array.from({ length: count }, (_, index) => ({
      modelId: `b${index}`, name: "b", kind: "box", visible: true,
      transform: { position: { x: index, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.2, y: 0.2, z: 0.2 } },
      physics: { type: "dynamic", mass: 1, friction: 0.5, restitution: 0 },
    })),
  },
});

function manager(limits = {}, clock = { t: 1_000 }) {
  let next = 0;
  return { clock, sessions: new WorldSessionManager({ limits, now: () => clock.t, newId: () => `w${(next += 1)}` }) };
}

const code = async (run: () => Promise<unknown> | unknown) => {
  try { await run(); } catch (error) { if (error instanceof WorldSessionError) return error.code; throw error; }
  return "none";
};

describe("WorldSessionManager", () => {
  it("create/get/step/close 全周期，close 后不可再取", async () => {
    const { sessions } = manager();
    const { info, observation } = await sessions.create(alice, reset());
    expect(info).toMatchObject({ worldId: "w1", tick: 0, seed: 1, sceneId: "s", objectCount: 1 });
    expect(observation.tick).toBe(0);
    expect(sessions.get(alice, "w1").step({ ticks: 6 }).tickAfter).toBe(6);
    expect(sessions.describe(alice, "w1").tick).toBe(6);
    expect(sessions.close(alice, "w1")).toBe(true);
    expect(sessions.close(alice, "w1")).toBe(false);
    expect(await code(() => sessions.get(alice, "w1"))).toBe("not-found");
    expect(sessions.size).toBe(0);
  });

  it("归属隔离：其他主体/其他项目访问与不存在一视同仁", async () => {
    const { sessions } = manager();
    await sessions.create(alice, reset());
    expect(await code(() => sessions.get(bob, "w1"))).toBe("not-found");
    expect(await code(() => sessions.get(aliceOtherProject, "w1"))).toBe("not-found");
    expect(sessions.close(bob, "w1")).toBe(false);
    expect(sessions.list(bob)).toEqual([]);
    expect(sessions.list(alice)).toHaveLength(1);
    sessions.dispose();
  });

  it("配额：全局并发数、主体并发数、单世界内存、总内存预算", async () => {
    const global = manager({ maxWorlds: 2, maxWorldsPerPrincipal: 5 });
    await global.sessions.create(alice, reset());
    await global.sessions.create(bob, reset());
    expect(await code(() => global.sessions.create({ projectId: "p9", principal: "c" }, reset()))).toBe("quota-exceeded");

    const owner = manager({ maxWorldsPerPrincipal: 1 });
    await owner.sessions.create(alice, reset());
    expect(await code(() => owner.sessions.create(alice, reset()))).toBe("quota-exceeded");
    await owner.sessions.create(bob, reset());

    const single = manager({ maxWorldBytes: 300 * 1024 });
    expect(await code(() => single.sessions.create(alice, reset(1, 20)))).toBe("quota-exceeded");
    expect(single.sessions.size).toBe(0);

    const total = manager({ maxTotalBytes: 600 * 1024 });
    await total.sessions.create(alice, reset());
    await total.sessions.create(bob, reset());
    expect(await code(() => total.sessions.create({ projectId: "p", principal: "z" }, reset()))).toBe("quota-exceeded");
    for (const m of [global, owner, single, total]) m.sessions.dispose();
  });

  it("并发 create 不会同时通过配额检查而超额", async () => {
    const { sessions } = manager({ maxWorlds: 2, maxWorldsPerPrincipal: 2 });
    const results = await Promise.allSettled([1, 2, 3, 4].map((seed) => sessions.create({ projectId: "p", principal: `u${seed}` }, reset(seed))));
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(2);
    expect(sessions.size).toBe(2);
    sessions.dispose();
  });

  it("空闲超时回收：get 刷新计时，超时后被 sweepIdle 清除，创建时也会顺带回收", async () => {
    const { sessions, clock } = manager({ idleTimeoutMs: 1_000, maxWorlds: 1 });
    await sessions.create(alice, reset());
    clock.t += 900;
    sessions.get(alice, "w1");
    clock.t += 900;
    expect(sessions.sweepIdle()).toBe(0);
    clock.t += 200;
    expect(await code(() => sessions.create(bob, reset()))).toBe("none");
    expect(await code(() => sessions.get(alice, "w1"))).toBe("not-found");
    expect(sessions.size).toBe(1);
    sessions.dispose();
  });

  it("restore：给 worldId 原地替换状态；不给则新建世界并占配额；坏快照不破坏原世界", async () => {
    const { sessions } = manager({ maxWorldsPerPrincipal: 2 });
    await sessions.create(alice, reset(5));
    const world = sessions.get(alice, "w1");
    world.step({ ticks: 30 });
    const snapshot = world.snapshot();
    world.step({ ticks: 60 });
    expect(sessions.describe(alice, "w1").tick).toBe(90);

    const rewound = await sessions.restore(alice, snapshot, "w1");
    expect(rewound.info).toMatchObject({ worldId: "w1", tick: 30 });
    const forked = await sessions.restore(alice, snapshot);
    expect(forked.info).toMatchObject({ worldId: "w2", tick: 30 });
    expect(forked.observation.stateHash).toBe(rewound.observation.stateHash);
    expect(await code(() => sessions.restore(alice, snapshot))).toBe("quota-exceeded");

    await expect(sessions.restore(alice, { ...snapshot, snapshotHash: "0".repeat(64) }, "w1")).rejects.toThrow(/snapshotHash/);
    expect(sessions.describe(alice, "w1").tick).toBe(30);
    expect(await code(() => sessions.restore(bob, snapshot, "w1"))).toBe("not-found");
    sessions.dispose();
  });

  it("dispose 释放所有世界", async () => {
    const { sessions } = manager();
    await sessions.create(alice, reset());
    await sessions.create(bob, reset());
    sessions.dispose();
    expect(sessions.size).toBe(0);
  });
});
