import { describe, expect, it, vi } from "vitest";
import { createShallowChannel, createTransientRegistry } from "./transientChannel.js";

/** 手动调度替身:捕获 rAF 任务,测试里可控推进。 */
function manualScheduler() {
  const tasks: Array<() => void> = [];
  return {
    tasks,
    schedule: (task: () => void) => {
      tasks.push(task);
      return tasks.length;
    },
    cancel: () => undefined,
    flushAll: () => {
      while (tasks.length) tasks.shift()!();
    },
  };
}

describe("transientChannel", () => {
  it("变更驱动:Object.is 相同值零通知,变化恰好一次(合帧)", () => {
    const scheduler = manualScheduler();
    const registry = createTransientRegistry(scheduler);
    const channel = registry.channel<number>("t", { schedule: scheduler.schedule, cancel: scheduler.cancel });
    const listener = vi.fn();
    channel.subscribe(listener);
    channel.publish(1);
    channel.publish(1);
    channel.publish(1);
    expect(listener).not.toHaveBeenCalled();
    expect(scheduler.tasks).toHaveLength(1);
    scheduler.flushAll();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1);
  });

  it("浅比较通道:对象字段全等零通知,任一字段变化通知", () => {
    const scheduler = manualScheduler();
    const registry = createTransientRegistry(scheduler);
    const channel = createShallowChannel<{ time: number; playing: boolean }>(registry, "anim");
    const listener = vi.fn();
    channel.subscribe(listener);
    channel.publish({ time: 1, playing: true });
    channel.publish({ time: 1, playing: true });
    expect(scheduler.tasks).toHaveLength(1);
    channel.publish({ time: 2, playing: true });
    // 合帧语义:未 flush 的帧内重复 publish 不再排队,监听器只收最终值。
    expect(scheduler.tasks).toHaveLength(1);
    scheduler.flushAll();
    expect(listener).toHaveBeenLastCalledWith({ time: 2, playing: true });
  });

  it("合帧后按注册顺序通知全部监听器,退订后不再通知", () => {
    const scheduler = manualScheduler();
    const registry = createTransientRegistry(scheduler);
    const channel = registry.channel<string>("s", { schedule: scheduler.schedule, cancel: scheduler.cancel });
    const a = vi.fn();
    const b = vi.fn();
    const off = channel.subscribe(a);
    channel.subscribe(b);
    channel.publish("x");
    off();
    scheduler.flushAll();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("x");
  });

  it("订阅前发布的值经 snapshot 可读;订阅后新发布立即进入下一帧快照", () => {
    const scheduler = manualScheduler();
    const registry = createTransientRegistry(scheduler);
    const channel = registry.channel<number>("n", { schedule: scheduler.schedule, cancel: scheduler.cancel });
    channel.publish(7);
    expect(channel.snapshot()).toBe(7);
    channel.publish(9);
    expect(channel.snapshot()).toBe(9);
  });

  it("无监听时 publish 只更新快照不排任务(零成本)", () => {
    const scheduler = manualScheduler();
    const registry = createTransientRegistry(scheduler);
    const channel = registry.channel<number>("idle", { schedule: scheduler.schedule, cancel: scheduler.cancel });
    for (let index = 0; index < 1000; index += 1) channel.publish(index);
    expect(scheduler.tasks).toHaveLength(0);
    expect(channel.snapshot()).toBe(999);
  });

  it("dispose 清空全部通道与监听", () => {
    const scheduler = manualScheduler();
    const registry = createTransientRegistry(scheduler);
    const channel = registry.channel<number>("d", { schedule: scheduler.schedule, cancel: scheduler.cancel });
    const listener = vi.fn();
    channel.subscribe(listener);
    registry.dispose();
    channel.publish(1);
    scheduler.flushAll();
    expect(listener).not.toHaveBeenCalled();
    expect(registry.peek<number>("d")).toBeUndefined();
  });
});
