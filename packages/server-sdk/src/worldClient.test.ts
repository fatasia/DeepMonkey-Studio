import { describe, expect, it, vi } from "vitest";
import { WorldApiContractError } from "@bim-studio/contracts";
import { ServerRequestError } from "./serverClient.js";
import { WorldApiError, WorldClient } from "./worldClient.js";

const scene = { schemaVersion: 1 as const, id: "s", primitives: [], models: [] };
const info = { worldId: "w-1", seed: 1, tick: 0, sceneId: "s", objectCount: 0, createdAt: "t", lastUsedAt: "t" };
const observation = { observationVersion: "1", tick: 0, timeSeconds: 0, seed: 1, stateHash: "a".repeat(64) };

function stub(handler: (path: string, init: RequestInit | undefined) => unknown) {
  const request = vi.fn(async (path: string, init?: RequestInit) => handler(path, init));
  return { request: request as never, calls: request.mock.calls as Array<[string, RequestInit | undefined]> };
}

describe("WorldClient", () => {
  it("reset 返回句柄，step/observe/snapshot/restore/close 走对应路径与方法", async () => {
    const { request, calls } = stub((path) => {
      if (path.endsWith("/worlds")) return { output: { world: info, observation } };
      if (path.endsWith("/step")) return { output: { ticksAdvanced: 6, tickBefore: 0, tickAfter: 6, commandResults: [], traceHash: "t", observation } };
      if (path.endsWith("/observe")) return { output: { worldId: "w-1", observation } };
      if (path.endsWith("/snapshot")) return { output: { worldId: "w-1", snapshot: { tick: 6 } } };
      if (path.endsWith("/restore")) return { output: { world: info, observation } };
      return { output: { worldId: "w-1", closed: true } };
    });
    const client = new WorldClient({ request }, "project-1");
    const world = await client.reset({ seed: 1, scene });
    expect(world.worldId).toBe("w-1");
    expect(world.initialObservation?.tick).toBe(0);

    expect((await world.step({ dt: 0.1, action: { events: [{ name: "go" }] } })).ticksAdvanced).toBe(6);
    expect((await world.observe({ channels: ["poses"] })).tick).toBe(0);
    expect(await world.snapshot()).toEqual({ tick: 6 });
    expect(await world.close()).toBe(true);

    expect(calls.map(([path, init]) => `${init?.method} ${path}`)).toEqual([
      "POST /api/projects/project-1/worlds",
      "POST /api/projects/project-1/worlds/w-1/step",
      "POST /api/projects/project-1/worlds/w-1/observe",
      "POST /api/projects/project-1/worlds/w-1/snapshot",
      "DELETE /api/projects/project-1/worlds/w-1",
    ]);
    expect(JSON.parse(calls[1]![1]!.body as string)).toEqual({ dt: 0.1, action: { events: [{ name: "go" }] } });
  });

  it("非法输入在本地以合同错误失败，不发请求", async () => {
    const { request, calls } = stub(() => ({ output: {} }));
    const client = new WorldClient({ request }, "p");
    const world = client.attach("w-1");
    await expect(world.step({ dt: 0.02 })).rejects.toThrow(WorldApiContractError);
    await expect(world.step({})).rejects.toThrow(/二选一/);
    await expect(client.reset({ seed: -1, scene })).rejects.toThrow(WorldApiContractError);
    await expect(world.observe({ sensors: [{ id: "x", kind: "thermal" as never }] })).rejects.toThrow(WorldApiContractError);
    expect(calls).toHaveLength(0);
    expect(() => new WorldClient({ request }, "../x")).toThrow();
  });

  it("服务端失败时用信封里的 warnings 作为可操作原因", async () => {
    const failure = new ServerRequestError("请求失败：404", 404, { status: "blocked", warnings: ["世界不存在、已关闭或已因空闲被回收：w-1"] });
    const { request } = stub(() => { throw failure; });
    const error = await new WorldClient({ request }, "p").attach("w-1").step({ ticks: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorldApiError);
    expect((error as WorldApiError).message).toMatch(/世界不存在/);
    expect((error as WorldApiError).status).toBe(404);
  });
});
