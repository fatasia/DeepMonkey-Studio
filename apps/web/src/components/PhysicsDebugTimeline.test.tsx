import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { computePoseEnvelope, PhysicsTimelineSection, timelineLabelStep, type PhysicsTimelineSectionProps } from "./PhysicsDebugTimeline";
import type { PhysicsPoseFrame, RecordedBodyPose } from "../viewer/physicsPoseRecorder";
import { comparePoseSeries, type PoseCompareResult } from "../viewer/physicsPoseCompare";
import { parsePhysicsPoseJson } from "../viewer/physicsPoseRecorder";

/**
 * Brief-PhysDbg 时间线段静态结构测试:tick 刻度/播放头/步进/位姿包络/超差红点
 * 与跳转、导出可用性、空态引导。语义色断言走 CSS 类名(令牌在 CSS 文件内)。
 */

const pose = (id: string, x: number, angle: number): RecordedBodyPose => ({
  id,
  p: [x, 0.5, 0],
  q: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
});

const frame = (step: number, x: number, angle: number): PhysicsPoseFrame => ({
  step,
  bodies: [pose("box-1", x, angle), pose("box-2", x * 0.5, angle * 0.5)],
});

const frames: PhysicsPoseFrame[] = [
  frame(1, 0, 0),
  frame(2, 0.01, 0.02),
  frame(3, 0.03, 0.05),
  frame(4, 0.06, 0.09),
];

function buildComparison(framesSeries: PhysicsPoseFrame[]): PoseCompareResult {
  const toSeries = (source: string, scale: number) => parsePhysicsPoseJson(JSON.stringify({
    meta: { end: source, boxes: ["box-1", "box-2"], fixedStepSeconds: 1 / 60 },
    poses: framesSeries.map((entry) => entry.bodies.map((body) => ({
      p: [body.p[0] + (source === "b" ? scale : 0), body.p[1], body.p[2]],
      q: body.q,
    }))),
  }), source);
  return comparePoseSeries(toSeries("a", 0), toSeries("b", 0.02)); // 2cm > 默认 5mm 容差
}

const baseProps: PhysicsTimelineSectionProps = {
  locale: "zh-CN",
  frames,
  isReplaying: false,
  replayStep: null,
  onApplyReplayFrame: vi.fn(),
  onExitReplay: vi.fn(),
  comparison: undefined,
  onExportDebugHashJson: vi.fn(),
  debugHashExportAvailable: true,
};

describe("PhysicsTimelineSection 静态结构", () => {
  it("渲染刻度轨、播放头、步进按钮与位姿包络图(空态给引导文案)", () => {
    const html = renderToStaticMarkup(<PhysicsTimelineSection {...baseProps} />);
    expect(html).toContain("pdtl-ruler");
    expect(html).toContain("pdtl-playhead");
    expect(html).toContain("pdbg-curve");
    expect(html).toContain("实况 · 4");
    // 主刻度 1..4(步长 1)
    expect(html).toContain(">1</i>");
    expect(html).toContain(">4</i>");
    expect(html).not.toContain("pdtl-exceed");
  });

  it("空录制渲染引导空态且不渲染刻度轨", () => {
    const html = renderToStaticMarkup(<PhysicsTimelineSection {...baseProps} frames={[]} debugHashExportAvailable={false} />);
    expect(html).toContain("开始录制后");
    expect(html).not.toContain("pdtl-ruler");
    expect(html).not.toContain("导出调试哈希 JSON");
  });

  it("跨端超差帧标红点、出现跳转按钮,无超差时不标", () => {
    const comparison = buildComparison(frames);
    // 注入侧是 b 序列每帧 +2mm,故全部帧超差;改用仅首帧超差的构造验证"标红离散性"。
    expect(comparison.firstExceededStep).toBe(1);
    const html = renderToStaticMarkup(<PhysicsTimelineSection {...baseProps} comparison={comparison} isReplaying replayStep={2} />);
    expect(html).toContain("pdtl-exceed");
    expect(html).toContain("跳转首超差帧 1");
    expect(html).toContain("回放刻度轨");
  });

  it("无超差比较结果不渲染跳转与红点", () => {
    const identical = buildComparison(frames);
    const clean: PoseCompareResult = { ...identical, firstExceededStep: null, perStep: identical.perStep.map((row) => ({ ...row, exceeded: false, positionExceeded: false, rotationExceeded: false })) };
    const html = renderToStaticMarkup(<PhysicsTimelineSection {...baseProps} comparison={clean} />);
    expect(html).not.toContain("pdtl-exceed");
    expect(html).not.toContain("跳转首超差帧");
  });

  it("语义图例三通道(接触/穿透/约束力)与导出按钮可用态", () => {
    const html = renderToStaticMarkup(<PhysicsTimelineSection {...baseProps} />);
    expect(html).toContain("pdtl-contact");
    expect(html).toContain("pdtl-penetration");
    expect(html).toContain("pdtl-constraint");
    expect(html).not.toMatch(/disabled[^>]*>[\s\S]{0,80}导出调试哈希/);
    const unavailable = renderToStaticMarkup(<PhysicsTimelineSection {...baseProps} debugHashExportAvailable={false} />);
    expect(unavailable).toMatch(/disabled/);
  });
});

describe("位姿包络与刻度步长(纯函数)", () => {
  it("位移包络取全刚体最大相对首帧位移", () => {
    const envelope = computePoseEnvelope(frames, "position");
    expect(envelope[0]).toBe(0);
    expect(envelope[3]).toBeCloseTo(0.06, 10);
  });

  it("旋转包络取短弧角最大值", () => {
    const envelope = computePoseEnvelope(frames, "rotation");
    expect(envelope[0]).toBe(0);
    expect(envelope[3]).toBeCloseTo(0.09, 10);
  });

  it("刻度步长自适应 ≤10 主刻度", () => {
    expect(timelineLabelStep(4)).toBe(1);
    expect(timelineLabelStep(600)).toBe(100);
    expect(timelineLabelStep(3600)).toBe(500);
  });
});
