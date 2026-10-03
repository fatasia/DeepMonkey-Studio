/**
 * S2d 行为轨迹回放审阅器 SSR 静态标记测试。
 *
 * 与 G2-S2a 同范式(renderToStaticMarkup):断言审阅器结构(时间轴 scrub 轨道、
 * outcome 徽标、before/after、步进、导出、空态)与只读纪律;指针 scrub/步进等
 * 真实交互归 headless Chrome 视觉闭环(g2-s2b-s2d-visual-gate.mjs)。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { BehaviorTraceEntry } from "../scripting/behaviorTraceLog";
import { playTraceStore } from "../scripting/playTraceStore";
import { BehaviorTraceReplay } from "./BehaviorTraceReplay";

function entry(partial: Partial<BehaviorTraceEntry> & { seq: number }): BehaviorTraceEntry {
  return {
    atMs: 0,
    graphId: "valve-guard",
    eventNodeId: "tick-1",
    actionNodeId: "act-1",
    action: "set-value",
    target: "temperature",
    before: "10",
    after: "80",
    outcome: "applied",
    ...partial,
  };
}

afterEach(() => {
  playTraceStore.resetPlayTrace("cleanup");
});

function renderTrace(): string {
  return renderToStaticMarkup(<BehaviorTraceReplay locale="zh-CN" />);
}

describe("BehaviorTraceReplay SSR (S2d)", () => {
  it("renders the empty reviewer before any trace exists", () => {
    playTraceStore.resetPlayTrace("session-empty");
    const html = renderTrace();
    expect(html).toContain("尚未产生行为轨迹");
    expect(html).toContain("回放不写场景状态");
    expect(html).toContain("导出 JSON");
    expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(1); // 导出禁用
  });

  it("renders source tracks, outcome markers, playhead and the detail card for the followed latest entry", () => {
    playTraceStore.resetPlayTrace("session-1");
    playTraceStore.recordPlayTrace("valve-guard", [
      entry({ seq: 1, atMs: 100, outcome: "applied", before: "10", after: "80" }),
      entry({ seq: 2, atMs: 300, outcome: "skipped", action: "condition", reason: "condition-false" }),
      entry({ seq: 3, atMs: 500, outcome: "rejected", reason: "单次派发动作数超过上限 8" }),
    ]);
    const html = renderTrace();
    // 摘要三态
    expect(html).toContain("条目 3");
    expect(html).toContain("来源 1");
    expect(html).toContain("0.50s"); // 时间域跨度
    // 三种 outcome 徽标与标记
    expect(html).toContain("is-applied");
    expect(html).toContain("is-skipped");
    expect(html).toContain("is-rejected");
    expect(html).toContain("已执行");
    expect(html).toContain("已跳过");
    expect(html).toContain("已拒绝");
    // 跟随最新:详情卡停在第 3 条,rejected 理由可见;初始跟随态不显示"已溢出"旁注
    expect(html).toContain("序号 3 · 0.500s</small>");
    expect(html).toContain("#3"); // 条目标签
    expect(html).toContain("单次派发动作数超过上限 8");
    expect(html).not.toContain("已溢出");
    expect(html).toContain("trace-replay-playhead");
    // before/after 摘要 mono 呈现(第 3 条无 before/after,但 label 齐备)
    expect(html).toContain("前值");
    expect(html).toContain("后值");
    // 步进四键 + 只读声明
    expect((html.match(/trace-replay-step/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain("回放为只读审阅");
  });

  it("degrades to seq-order domain when all timestamps are equal and renders the sampled note for dense tracks", () => {
    playTraceStore.resetPlayTrace("session-2");
    playTraceStore.recordPlayTrace(
      "valve-guard",
      Array.from({ length: 400 }, (_, index) => entry({ seq: index + 1, atMs: 0, after: `v${index + 1}` })),
    );
    const html = renderTrace();
    expect(html).toContain("顺序域"); // 等值时间域退化
    expect(html).toContain("按 1/3 采样显示"); // 400 → stride 3(≤160 上限)
    expect((html.match(/trace-replay-marker/g) ?? []).length).toBeLessThanOrEqual(200); // 抽稀后 DOM 有界
    expect(html).toContain("400/400"); // 跟随最新停在末条
  });

  it("keeps the reviewer read-only: no scene-mutating controls are rendered", () => {
    playTraceStore.resetPlayTrace("session-3");
    playTraceStore.recordPlayTrace("valve-guard", [entry({ seq: 1 })]);
    const html = renderTrace();
    expect(html).not.toContain("应用");
    expect(html).not.toContain("写入场景");
    expect(html).toContain("重新进入播放会话");
  });
});
