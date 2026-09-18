import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { createScenePublicationActions } from "./scenePublicationActions";
import type { AppRoute } from "../appRoute";

const api = vi.hoisted(() => ({ deleteScene: vi.fn(), unpublishScene: vi.fn() }));
vi.mock("../api", () => ({ api }));
vi.mock("../delivery/sceneClientPackage", () => ({ prepareSceneClientPackage: vi.fn() }));
const confirm = vi.fn();
beforeEach(() => { vi.clearAllMocks(); confirm.mockReturnValue(true); vi.stubGlobal("window", { confirm }); });
afterEach(() => vi.unstubAllGlobals());
function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(action: "delete" | "unpublish", manager = false) {
  const target = { schemaVersion: 1, id: "scene", projectId: "project", name: "Original", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "old", updatedAt: "old", publishedAt: "v1" } as SceneSnapshot;
  const foreign = { ...structuredClone(target), projectId: "foreign", name: "Foreign" };
  const other = { ...structuredClone(target), id: "other", name: "Other" };
  const state = { items: [structuredClone(target), foreign, other], active: manager ? undefined : structuredClone(target) as SceneSnapshot | undefined,
    route: (manager ? { view: "manager" } : { view: "studio", sceneId: target.id }) as AppRoute };
  const operation = deferred(); const call = action === "delete" ? api.deleteScene : api.unpublishScene; call.mockReturnValue(operation.promise);
  const context = {
    project: { id: "project", models: [] } as unknown as ProjectRecord, activeScene: state.active, getActiveScene: () => state.active,
    sceneApplyVersionRef: { current: 1 }, scenes: state.items, getScenes: () => state.items,
    route: state.route, getRoute: () => state.route, locale: "zh-CN" as const,
    studioPublishMode: "webgl" as const, studioPublishPerformance: "standard" as const, enablePublishedCloudScene: vi.fn(), navigate: vi.fn(),
    sortScenesByTime: (items: SceneSnapshot[]) => items, showError: vi.fn(), setMessage: vi.fn(), setSceneName: vi.fn(), setStudioPublishOpen: vi.fn(),
    setScenes: vi.fn((update: SetStateAction<SceneSnapshot[]>) => { state.items = typeof update === "function" ? update(state.items) : update; }),
    setActiveScene: vi.fn((update: SetStateAction<SceneSnapshot | undefined>) => { state.active = typeof update === "function" ? update(state.active) : update; }),
    buildPublicationArtifact: vi.fn(),
  };
  const actions = createScenePublicationActions(context, vi.fn());
  return { target, state, context, operation, call, run: () => action === "delete" ? actions.deleteScene(target) : actions.unpublishScene(target) };
}
function quiet(context: ReturnType<typeof setup>["context"]) {
  expect(context.setActiveScene).not.toHaveBeenCalled(); expect(context.navigate).not.toHaveBeenCalled();
  expect(context.setMessage).not.toHaveBeenCalled(); expect(context.showError).not.toHaveBeenCalled();
}

describe.each(["delete", "unpublish"] as const)("%s scene response ownership", action => {
  it("rejects cross-project input before an API request", async () => {
    const f = setup(action); f.target.projectId = "foreign";
    await f.run(); expect(f.call).not.toHaveBeenCalled(); expect(f.context.setScenes).not.toHaveBeenCalled();
    expect(f.context.setActiveScene).not.toHaveBeenCalled();
  });

  it("freezes target identity, publication and display name before awaiting the API", async () => {
    const f = setup(action), pending = f.run();
    f.target.id = "mutated"; f.target.projectId = "foreign"; f.target.name = "Mutated"; f.target.publishedAt = "v2";
    f.operation.resolve(); await pending;
    expect(f.call).toHaveBeenCalledExactlyOnceWith("project", "scene");
    expect(f.state.items.find(item => item.id === "scene" && item.projectId === "foreign")?.name).toBe("Foreign");
    const item = f.state.items.find(item => item.id === "scene" && item.projectId === "project");
    if (action === "delete") expect(item).toBeUndefined(); else expect(item).not.toHaveProperty("publishedAt");
    expect(f.context.setMessage).toHaveBeenCalledWith(expect.stringContaining("Original"));
    expect(f.context.setMessage.mock.calls.flat().join(" ")).not.toContain("Mutated");
  });

  it.each(["different scene", "same ID reopened", "unloaded"])("keeps a late success out of the UI after %s while updating its list entry", async change => {
    const f = setup(action), pending = f.run();
    if (change === "different scene") f.state.active = { ...f.target, id: "other" };
    if (change === "same ID reopened") { f.state.active = structuredClone(f.target); f.context.sceneApplyVersionRef.current++; }
    if (change === "unloaded") f.state.active = undefined;
    const active = structuredClone(f.state.active); f.operation.resolve(); await pending;
    quiet(f.context); expect(f.state.active).toEqual(active);
    expect(f.context.setScenes).toHaveBeenCalledOnce();
    const item = f.state.items.find(item => item.projectId === "project" && item.id === "scene");
    if (action === "delete") expect(item).toBeUndefined(); else expect(item).not.toHaveProperty("publishedAt");
    expect(f.state.items.find(item => item.projectId === "foreign")?.publishedAt).toBe("v1");
  });

  it("reports a current failure once without state writes", async () => {
    const f = setup(action), before = structuredClone(f.state), error = new Error("request failed"), pending = f.run();
    f.operation.reject(error); await pending;
    expect(f.context.showError).toHaveBeenCalledExactlyOnceWith(error); expect(f.state).toEqual(before);
    expect(f.context.setScenes).not.toHaveBeenCalled(); expect(f.context.setActiveScene).not.toHaveBeenCalled();
    expect(f.context.navigate).not.toHaveBeenCalled(); expect(f.context.setMessage).not.toHaveBeenCalled();
  });

  it("silences errors from an old scene generation", async () => {
    const f = setup(action), pending = f.run(); f.context.sceneApplyVersionRef.current++;
    f.operation.reject(new Error("old request failed")); await pending;
    quiet(f.context); expect(f.context.setScenes).not.toHaveBeenCalled();
  });

  it("reports successful manager operations with no active scene", async () => {
    const f = setup(action, true), pending = f.run(); f.operation.resolve(); await pending;
    expect(f.context.setMessage).toHaveBeenCalledOnce(); expect(f.context.showError).not.toHaveBeenCalled();
    expect(f.context.setActiveScene).not.toHaveBeenCalled(); expect(f.context.navigate).not.toHaveBeenCalled();
  });

  for (const change of ["route only", "route reopened"] as const) for (const result of ["success", "error"] as const) {
    it(`isolates ${result} after ${change} with unchanged active scene and epoch`, async () => {
      const f = setup(action), pending = f.run(), originalRoute = f.state.route;
      f.state.route = { view: "manager" };
      if (change === "route reopened") f.state.route = structuredClone(originalRoute);
      const active = structuredClone(f.state.active);
      if (result === "success") f.operation.resolve(); else f.operation.reject(new Error("old route error"));
      await pending; quiet(f.context); expect(f.state.active).toEqual(active);
      expect(f.context.sceneApplyVersionRef.current).toBe(1);
      expect(f.context.setScenes).toHaveBeenCalledTimes(result === "success" ? 1 : 0);
      const item = f.state.items.find(value => value.id === "scene" && value.projectId === "project");
      if (result === "success" && action === "delete") expect(item).toBeUndefined();
      else if (result === "success") expect(item).not.toHaveProperty("publishedAt");
      else expect(item).toHaveProperty("publishedAt", "v1");
    });
  }

  it("rechecks route ownership when a queued active-state updater actually executes", async () => {
    const f = setup(action); let queued: SetStateAction<SceneSnapshot | undefined>;
    f.context.setActiveScene.mockImplementation(update => { queued = update; });
    const pending = f.run(); f.operation.resolve(); await pending;
    expect(typeof queued!).toBe("function");
    const before = structuredClone(f.state.active); f.state.route = { view: "manager" };
    const update = queued!;
    f.state.active = typeof update === "function" ? update(f.state.active) : update;
    expect(f.state.active).toEqual(before);
  });
});

describe("current scene discard updates", () => {
  it("clears the current scene and returns to manager after deletion", async () => {
    const f = setup("delete"), pending = f.run(); f.operation.resolve(); await pending;
    expect(f.state.active).toBeUndefined(); expect(f.context.navigate).toHaveBeenCalledExactlyOnceWith({ view: "manager" });
    expect(f.state.items.map(item => [item.projectId, item.id])).toEqual([["foreign", "scene"], ["project", "other"]]);
  });

  it("keeps newer draft fields in both the latest list and active state when unpublishing", async () => {
    const f = setup("unpublish"), pending = f.run();
    f.state.items[0] = { ...f.target, name: "Latest list", updatedAt: "new-list" };
    f.state.active = { ...f.target, name: "Latest active", camera: { ...f.target.camera, position: { x: 99, y: 2, z: 3 } } };
    f.operation.resolve(); await pending;
    expect(f.state.items[0]).toMatchObject({ name: "Latest list", updatedAt: "new-list" });
    expect(f.state.active).toMatchObject({ name: "Latest active", camera: { position: { x: 99 } } });
    expect(f.state.items[0]).not.toHaveProperty("publishedAt"); expect(f.state.active).not.toHaveProperty("publishedAt");
    expect(typeof f.context.setScenes.mock.calls[0]![0]).toBe("function");
    expect(typeof f.context.setActiveScene.mock.calls[0]![0]).toBe("function");
  });

  it("preserves a newer publication in the list and active scene", async () => {
    const f = setup("unpublish"), pending = f.run();
    f.state.items[0] = { ...f.target, name: "New publication", publishedAt: "v2" }; f.state.active = structuredClone(f.state.items[0]);
    const before = structuredClone(f.state); f.operation.resolve(); await pending;
    expect(f.state).toEqual(before);
    expect(f.context.setMessage).not.toHaveBeenCalled();
  });

  it("does not show an obsolete unpublish success for a manager list with a newer publication", async () => {
    const f = setup("unpublish", true), pending = f.run();
    f.state.items[0] = { ...f.target, publishedAt: "v2", name: "New publication" };
    const before = structuredClone(f.state); f.operation.resolve(); await pending;
    expect(f.state).toEqual(before); expect(f.context.setMessage).not.toHaveBeenCalled();
    expect(f.context.showError).not.toHaveBeenCalled(); expect(f.context.navigate).not.toHaveBeenCalled();
  });

  it("does not request deletion when confirmation is declined", async () => {
    const f = setup("delete"); confirm.mockReturnValue(false); await f.run();
    expect(f.call).not.toHaveBeenCalled(); quiet(f.context); expect(f.context.setScenes).not.toHaveBeenCalled();
  });
});
