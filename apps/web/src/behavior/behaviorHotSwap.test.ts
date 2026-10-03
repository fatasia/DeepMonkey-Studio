import type { SceneBehaviorManagerEntry } from "./SceneBehaviorManager";
import type { SceneBehaviorModule } from "@bim-studio/scene-sdk";
import { describe, expect, it } from "vitest";
import {
  hotSwapDisabledReason,
  hotSwapVariantId,
  isHotSwapVariantModuleId,
  settleHotSwap,
} from "./behaviorHotSwap";

const scheduler = { state: "running", elapsedMs: 1200, fixedElapsedMs: 0, frame: 72, sequence: 3, pendingFixedMs: 0, droppedFixedSteps: 0, lastFrameDeltaMs: 16, timeScale: 1 };

const moduleOf = (id: string): SceneBehaviorModule =>
  ({ id, name: id, apiVersion: "1.0", code: "function onStart(ctx) {}", lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: ["scene.write"] });

const entryOf = (id: string, diagnostics: Partial<SceneBehaviorManagerEntry["diagnostics"]>): SceneBehaviorManagerEntry => ({
  module: moduleOf(id),
  diagnostics: {
    status: "running",
    moduleId: id,
    pendingInvocations: 0,
    completedInvocations: 4,
    droppedInvocations: 0,
    rejectedCommands: 0,
    averageExecutionMs: 1.2,
    lastExecutionMs: 1,
    scheduler,
    ...diagnostics,
  } as SceneBehaviorManagerEntry["diagnostics"],
});

describe("热插应用 UI 状态机(H-C6-S1 编辑器接线)", () => {
  it("变体 id 按原脚本 id 派生并逐次递进", () => {
    expect(hotSwapVariantId("behavior:abc", 1)).toBe("behavior:abc:hot1");
    expect(hotSwapVariantId("behavior:abc", 12)).toBe("behavior:abc:hot12");
    expect(isHotSwapVariantModuleId("behavior:abc:hot2", "behavior:abc")).toBe(true);
    expect(isHotSwapVariantModuleId("behavior:abc", "behavior:abc")).toBe(false);
    expect(isHotSwapVariantModuleId(undefined, "behavior:abc")).toBe(false);
  });

  it("禁用原因 fail-closed:作者调试/无名称/未运行/初始化中均有如实文案", () => {
    const running = entryOf("s1", { status: "running" });
    expect(hotSwapDisabledReason(running, false, true, "zh-CN")).toBeUndefined();
    expect(hotSwapDisabledReason(entryOf("s1", { status: "paused" }), false, true, "zh-CN")).toBeUndefined();
    expect(hotSwapDisabledReason(running, true, true, "zh-CN")).toContain("作者调试");
    expect(hotSwapDisabledReason(running, true, true, "zh-CN")).toContain("fail-closed");
    expect(hotSwapDisabledReason(running, false, false, "zh-CN")).toContain("脚本名称");
    expect(hotSwapDisabledReason(undefined, false, true, "zh-CN")).toContain("未在试运行");
    expect(hotSwapDisabledReason(entryOf("s1", { status: "initializing" }), false, true, "zh-CN")).toContain("初始化");
    expect(hotSwapDisabledReason(entryOf("s1", { status: "error" }), false, true, "zh-CN")).toContain("无法热插");
    expect(hotSwapDisabledReason(entryOf("s1", { status: "idle" }), false, true, "zh-CN")).toContain("无法热插");
  });

  it("结算:initializing 保持 pending,等握手完成", () => {
    expect(settleHotSwap(entryOf("s1", { status: "initializing", moduleId: "s1:hot1" }), { scriptId: "s1", fromModuleId: "s1" }, "zh-CN")).toBeUndefined();
  });

  it("结算:成功——moduleId 从起点变为新热插变体且无错误", () => {
    const first = settleHotSwap(entryOf("s1", { status: "running", moduleId: "s1:hot1" }), { scriptId: "s1", fromModuleId: "s1" }, "zh-CN");
    expect(first?.phase).toBe("applied");
    expect(first?.feedback).toContain("热插成功");
    // 连续热插:上一轮停在 hot1,本轮换到 hot2——起点锚定后仍能识别成功。
    const second = settleHotSwap(entryOf("s1", { status: "running", moduleId: "s1:hot2" }), { scriptId: "s1", fromModuleId: "s1:hot1" }, "zh-CN");
    expect(second?.phase).toBe("applied");
    const paused = settleHotSwap(entryOf("s1", { status: "paused", moduleId: "s1:hot3" }), { scriptId: "s1", fromModuleId: "s1:hot2" }, "zh-CN");
    expect(paused?.phase).toBe("applied");
  });

  it("结算:回归——连续热插 pending 首拍不得把上一轮变体状态误报成 success", () => {
    // 第二次点击瞬间,props 仍是点击前快照:moduleId 停在上一轮的 hot1、无错误。
    const stale = settleHotSwap(entryOf("s1", { status: "running", moduleId: "s1:hot1" }), { scriptId: "s1", fromModuleId: "s1:hot1" }, "zh-CN");
    expect(stale).toBeUndefined();
  });

  it("结算:回滚——lastError 带回滚标记优先于变体判定(二次热插回滚上一代变体)", () => {
    const rolled = settleHotSwap(entryOf("s1", { status: "running", moduleId: "s1", lastError: "热插失败已回滚:初始化超过 2000 ms" }), { scriptId: "s1", fromModuleId: "s1" }, "zh-CN");
    expect(rolled?.phase).toBe("rolled-back");
    expect(rolled?.feedback).toContain("已回滚原脚本");
    expect(rolled?.feedback).toContain("初始化超过 2000 ms");
    // 回滚的旧模块本身是上一代变体:moduleId 与起点一致且带 :hot 前缀,但 lastError 标记说了算。
    const rolledVariant = settleHotSwap(entryOf("s1", { status: "paused", moduleId: "s1:hot1", lastError: "热插失败已回滚:ReferenceError" }), { scriptId: "s1", fromModuleId: "s1:hot1" }, "zh-CN");
    expect(rolledVariant?.phase).toBe("rolled-back");
  });

  it("结算:失败——error 态如实呈现回滚失败;会话结束呈现结果未知", () => {
    const failed = settleHotSwap(entryOf("s1", { status: "error", lastError: "热插失败且回滚失败:worker crashed" }), { scriptId: "s1", fromModuleId: "s1" }, "zh-CN");
    expect(failed?.phase).toBe("failed");
    expect(failed?.feedback).toContain("回滚失败");
    expect(failed?.feedback).toContain("worker crashed");
    const unknown = settleHotSwap(undefined, { scriptId: "s1", fromModuleId: "s1" }, "zh-CN");
    expect(unknown?.phase).toBe("failed");
    expect(unknown?.feedback).toContain("结果未知");
  });

  it("结算:运行中但 moduleId 未变化且无标记——点击尚未传播,保持 pending 不误报", () => {
    expect(settleHotSwap(entryOf("s1", { status: "running", moduleId: "s1" }), { scriptId: "s1", fromModuleId: "s1" }, "zh-CN")).toBeUndefined();
    expect(settleHotSwap(entryOf("s1", { status: "paused", moduleId: "s1" }), { scriptId: "s1", fromModuleId: "s1" }, "zh-CN")).toBeUndefined();
  });
});
