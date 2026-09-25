import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "./commandBus";
import type { EngineEditCommand, EngineEditCommandInput } from "./engineEditCommand";

function visibilityInput(modelId: string, layerId: string, visible: boolean): EngineEditCommandInput {
  return { kind: "setLayerState", label: "切换图层可见性", target: { modelId, layerId }, patch: { visible } };
}

function inverseVisibilityInput(modelId: string, layerId: string, visible: boolean): EngineEditCommandInput {
  return { kind: "setLayerState", label: "inverse", target: { modelId, layerId }, patch: { visible } };
}

function transformInput(modelId: string): EngineEditCommandInput {
  return {
    kind: "setTransform",
    label: "编辑三维对象",
    target: { modelId },
    transform: { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  };
}

/** 顺序记录型 applier:按序推送收到的命令,可注入异常。 */
function recordingApplier(failOn?: (command: EngineEditCommand) => boolean) {
  const applied: EngineEditCommand[] = [];
  return {
    applied,
    apply(command: EngineEditCommand): void {
      if (failOn?.(command)) throw new Error("applier boom");
      applied.push(command);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CommandBus", () => {
  it("publish 同步冲刷:发布返回时命令已执行,时序与直调 setter 一致", () => {
    const bus = new CommandBus();
    const applier = recordingApplier();
    const events: string[] = [];

    bus.publish(visibilityInput("m1", "l1", false), applier);
    events.push("after-publish");

    expect(appliedOf(applier)).toEqual(["setLayerState:m1/l1:false"]);
    expect(events).toEqual(["after-publish"]);
    expect(bus.getRevision()).toBe(1);
  });

  it("publishWithResult 保留 setter 的 boolean 拒绝语义且仍写入命令日志", () => {
    const bus = new CommandBus();
    const applier = { apply: vi.fn(() => false) };
    const outcome = bus.publishWithResult(visibilityInput("m1", "l1", true), applier);
    expect(outcome.result).toBe(false);
    expect(outcome.command.id).toBe("editcmd-1");
    expect(bus.getRevision()).toBe(1);
    expect(bus.getLog()).toHaveLength(1);
  });

  it("undo/redo 应用 inverse，revision 单调且失败时保持栈原子", () => {
    const bus = new CommandBus();
    const applied: string[] = [];
    const applier = { apply: vi.fn((command: EngineEditCommand) => {
      applied.push(command.kind === "setLayerState" ? String(command.patch.visible) : command.kind);
    }) };
    const command = bus.publish({ ...visibilityInput("m1", "l1", false), inverse: inverseVisibilityInput("m1", "l1", true) }, applier);
    expect(bus.undo(command, applier)).toBe(true);
    expect(applied).toEqual(["false", "true"]);
    expect(bus.getRevision()).toBe(2);
    expect(bus.redo(command, applier)).toBe(true);
    expect(applied).toEqual(["false", "true", "false"]);
    expect(bus.getRevision()).toBe(3);
    expect(bus.undo(command, applier)).toBe(true);
    const failing = new CommandBus();
    let badCalls = 0;
    const bad = { apply: vi.fn(() => { if (++badCalls > 1) throw new Error("inverse failed"); }) };
    failing.publish({ ...visibilityInput("m1", "l1", false), inverse: inverseVisibilityInput("m1", "l1", true) }, bad);
    expect(failing.undo(command, bad)).toBe(false);
    expect(failing.getRevision()).toBe(1);
  });

  it("命令 id 单调分配,baseRevision 记录发出时所见 revision", () => {
    const bus = new CommandBus();
    const applier = recordingApplier();

    const first = bus.publish(visibilityInput("m1", "l1", true), applier);
    const second = bus.publish(visibilityInput("m1", "l2", false), applier);

    expect(first.id).toBe("editcmd-1");
    expect(second.id).toBe("editcmd-2");
    expect(first.baseRevision).toBe(0);
    expect(second.baseRevision).toBe(1);
  });

  it("多条命令按发布顺序排队执行,revision 逐条单调递增", () => {
    const bus = new CommandBus();
    const applier = recordingApplier();

    const a = bus.publish(visibilityInput("m1", "l1", false), applier);
    const b = bus.publish(transformInput("m1"), applier);
    const c = bus.publish(visibilityInput("m1", "l1", true), applier);

    expect(appliedOf(applier)).toEqual(["setLayerState:m1/l1:false", "setTransform:m1", "setLayerState:m1/l1:true"]);
    expect(bus.getRevision()).toBe(3);
    expect(bus.getLog().map((entry) => [entry.command.id, entry.revision])).toEqual([
      [a.id, 1],
      [b.id, 2],
      [c.id, 3],
    ]);
  });

  it("applier 执行中嵌套 publish:新命令入队,由同一次冲刷按序继续执行", () => {
    const bus = new CommandBus();
    const applier = recordingApplier();
    let nested = false;
    const reentrant = {
      apply(command: EngineEditCommand): void {
        applier.apply(command);
        if (!nested) {
          nested = true;
          bus.publish(visibilityInput("m2", "root", false), applier);
        }
      },
    };

    bus.publish(visibilityInput("m1", "l1", true), reentrant);

    expect(appliedOf(applier)).toEqual(["setLayerState:m1/l1:true", "setLayerState:m2/root:false"]);
    expect(bus.getRevision()).toBe(2);
  });

  it("订阅者按应用顺序收到 {command, revision},退订后不再收到,退订幂等", () => {
    const bus = new CommandBus();
    const applier = recordingApplier();
    const seen: Array<[string, number]> = [];
    const unsubscribe = bus.subscribe((event) => seen.push([event.command.id, event.revision]));

    bus.publish(visibilityInput("m1", "l1", true), applier);
    unsubscribe();
    unsubscribe();
    bus.publish(visibilityInput("m1", "l1", false), applier);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[1]).toBe(1);
  });

  it("订阅者抛错不中断命令流,也不影响其他订阅者", () => {
    const bus = new CommandBus();
    const applier = recordingApplier();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy: number[] = [];
    bus.subscribe(() => {
      throw new Error("listener boom");
    });
    bus.subscribe((event) => healthy.push(event.revision));

    bus.publish(visibilityInput("m1", "l1", true), applier);

    expect(appliedOf(applier)).toEqual(["setLayerState:m1/l1:true"]);
    expect(healthy).toEqual([1]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("applier 抛错:错误传播、revision 不增、命令不入日志、队列清空", () => {
    const bus = new CommandBus();
    const applier = recordingApplier((command) => command.id === "editcmd-2");

    bus.publish(visibilityInput("m1", "l1", true), applier);
    expect(() => bus.publish(visibilityInput("m1", "l1", false), applier)).toThrow("applier boom");

    expect(bus.getRevision()).toBe(1);
    expect(bus.getLog()).toHaveLength(1);
    expect(appliedOf(applier)).toEqual(["setLayerState:m1/l1:true"]);
    // 队列不留幻影命令:下一条 publish 正常执行。
    const next = bus.publish(visibilityInput("m1", "l2", true), applier);
    expect(next.id).toBe("editcmd-3");
    expect(bus.getRevision()).toBe(2);
  });

  it("日志环形裁剪:超过 logLimit 时丢弃最旧条目", () => {
    const bus = new CommandBus({ logLimit: 2 });
    const applier = recordingApplier();

    bus.publish(visibilityInput("m1", "l1", true), applier);
    bus.publish(visibilityInput("m1", "l2", false), applier);
    bus.publish(visibilityInput("m1", "l3", true), applier);

    expect(bus.getLog().map((entry) => entry.command.kind === "setLayerState" ? entry.command.target.layerId : undefined)).toEqual(["l2", "l3"]);
    expect(bus.getRevision()).toBe(3);
  });

  it("replay 按日志顺序重放给新 applier,但不推进 revision、不写日志、不通知订阅者", () => {
    const bus = new CommandBus();
    const original = recordingApplier();
    bus.publish(visibilityInput("m1", "l1", false), original);
    bus.publish(transformInput("m1"), original);
    const subscriber = vi.fn();
    bus.subscribe(subscriber);
    const replayTarget = recordingApplier();

    const count = bus.replay(replayTarget);

    expect(count).toBe(2);
    expect(appliedOf(replayTarget)).toEqual(appliedOf(original));
    expect(bus.getRevision()).toBe(2);
    expect(bus.getLog()).toHaveLength(2);
    expect(subscriber).not.toHaveBeenCalled(); // replay 不触发订阅事件
  });

  it("空日志 replay 返回 0 且不调用 applier", () => {
    const bus = new CommandBus();
    const replayTarget = recordingApplier();

    expect(bus.replay(replayTarget)).toBe(0);
    expect(appliedOf(replayTarget)).toEqual([]);
  });
});

function appliedOf(applier: ReturnType<typeof recordingApplier>): string[] {
  return applier.applied.map((command) => {
    if (command.kind === "setLayerState") {
      return `setLayerState:${command.target.modelId}/${command.target.layerId}:${command.patch.visible}`;
    }
    if (command.kind === "setSceneEnv") return `setSceneEnv`;
    if (command.kind === "setLighting") return `setLighting`;
    if (command.kind === "setPhysicsState") return `setPhysicsState`;
    return `setTransform:${command.target.modelId}`;
  });
}
