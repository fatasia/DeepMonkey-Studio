import { describe, expect, it, vi } from "vitest";
import { DeepApp } from "./deepApp.js";
import { DeepAppCleanupError, DeepAppConfigurationError, DeepAppInitializationError } from "./deepAppErrors.js";
import { createDeepAppResource, type DeepAppPlugin } from "./appTypes.js";

describe("DeepApp", () => {
  it("installs dependency-ordered plugins and lets the host drive ordered frames", async () => {
    const events: string[] = [], value = createDeepAppResource<number>("fixture.value");
    const foundation: DeepAppPlugin<{ ticks: number }> = { id: "foundation", setup(context) {
      events.push("setup:foundation"); context.provide(value, 7);
      context.addFrameStage({ id: "early", priority: -1, execute: frame => {
        events.push(`frame:early:${frame.context.requireResource(value)}`); frame.context.state.ticks += 1;
      } });
      context.invalidate("foundation:ready");
      context.onDispose(() => events.push("dispose:foundation"));
    } };
    const renderer: DeepAppPlugin<{ ticks: number }> = { id: "renderer", dependencies: ["foundation"], setup(context) {
      events.push(`setup:renderer:${context.requireResource(value)}`);
      context.addFrameStage({ id: "late", priority: 1, execute: frame => events.push(`frame:late:${frame.context.state.ticks}`) });
      return () => { events.push("dispose:renderer"); };
    } };
    const app = await DeepApp.create({ state: { ticks: 0 }, plugins: [renderer, foundation] });
    expect(app.shouldRequestFrame()).toBe(true);
    expect(await app.advance(10)).toMatchObject({ status: "rendered", invalidationReasons: ["foundation:ready"] });
    expect(await app.advance(11)).toMatchObject({ status: "idle" });
    await app.dispose();
    expect(events).toEqual(["setup:foundation", "setup:renderer:7", "frame:early:7", "frame:late:1",
      "dispose:renderer", "dispose:foundation"]);
    expect(app.status).toBe("disposed");
  });

  it("rejects missing, cyclic, and duplicate plugin dependencies before setup", async () => {
    const setup = vi.fn(), missing: DeepAppPlugin<null> = { id: "missing", dependencies: ["base"], setup };
    await expect(DeepApp.create({ state: null, plugins: [missing] })).rejects.toBeInstanceOf(DeepAppConfigurationError);
    expect(setup).not.toHaveBeenCalled();
    const a: DeepAppPlugin<null> = { id: "a", dependencies: ["b"], setup }, b: DeepAppPlugin<null> = { id: "b", dependencies: ["a"], setup };
    await expect(DeepApp.create({ state: null, plugins: [a, b] })).rejects.toBeInstanceOf(DeepAppConfigurationError);
    await expect(DeepApp.create({ state: null, plugins: [a, a] })).rejects.toBeInstanceOf(DeepAppConfigurationError);
  });

  it("cleans a failing plugin and installed dependencies in strict reverse order", async () => {
    const events: string[] = [];
    const first: DeepAppPlugin<null> = { id: "first", setup(context) {
      context.onDispose(() => events.push("first:one")); context.onDispose(() => events.push("first:two"));
    } };
    const failing: DeepAppPlugin<null> = { id: "failing", dependencies: ["first"], setup(context) {
      context.onDispose(() => events.push("failing:partial")); throw new Error("setup exploded");
    } };
    const never: DeepAppPlugin<null> = { id: "never", dependencies: ["failing"], setup: vi.fn() };
    const error = await DeepApp.create({ state: null, plugins: [never, failing, first] }).catch(value => value);
    expect(error).toBeInstanceOf(DeepAppInitializationError);
    expect(error.trace).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "failing", status: "failed" }),
      expect.objectContaining({ stage: "never", status: "blocked" })]));
    expect(events).toEqual(["failing:partial", "first:two", "first:one"]);
    expect(never.setup).not.toHaveBeenCalled();
  });

  it("attempts every disposer, reports errors, and disposes only once", async () => {
    const events: string[] = [], plugin: DeepAppPlugin<null> = { id: "cleanup", setup(context) {
      context.onDispose(() => { events.push("one"); throw new Error("one failed"); });
      context.onDispose(async () => { events.push("two"); throw new Error("two failed"); });
      context.onDispose(() => events.push("three"));
    } };
    const app = await DeepApp.create({ state: null, plugins: [plugin] });
    const first = app.dispose();
    expect(app.dispose()).toBe(first);
    const error = await first.catch(value => value);
    expect(error).toBeInstanceOf(DeepAppCleanupError); expect(error.errors).toHaveLength(2);
    expect(events).toEqual(["three", "two", "one"]); expect(app.status).toBe("disposed");
  });

  it("fails closed on duplicate resources or frame stages", async () => {
    const resource = createDeepAppResource<number>("same");
    await expect(DeepApp.create({ state: null, plugins: [
      { id: "a", setup: context => context.provide(resource, 1) },
      { id: "b", dependencies: ["a"], setup: context => context.provide(resource, 2) },
    ] })).rejects.toThrow(/already provided/);
    await expect(DeepApp.create({ state: null, plugins: [
      { id: "a", setup: context => context.addFrameStage({ id: "same", execute() {} }) },
      { id: "b", setup: context => context.addFrameStage({ id: "same", execute() {} }) },
    ] })).rejects.toThrow(/initialization failed/);
  });
});
