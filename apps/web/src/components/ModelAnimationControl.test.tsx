import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { ModelAnimationControl } from "./ModelAnimationControl";

function fakeEngine(overrides: Record<string, unknown> = {}) {
  return {
    listAnimationClips: () => [{ id: "walk", name: "walk", duration: 1 }],
    getAnimationPlayback: () => ({ clipId: "walk", time: 0, duration: 1, playing: true }),
    getModelAnimationPlaybackState: () => ({ autoplay: true, loopMode: "loop" }),
    isAnimationEnabled: () => false,
    getModelRootMotionState: () => ({ enabled: false, trackResolved: false, unwrappedTime: 0, appliedTranslation: [0, 0, 0], lastTranslation: null, appliedRotation: [0, 0, 0, 1], lastRotation: null }),
    getModelRootMotionAvailability: () => ({ available: true, translation: true, rotation: false }),
    setModelRootMotion: vi.fn(() => true),
    resetModelRootMotion: vi.fn(() => true),
    ...overrides,
  } as unknown as ViewerEngine;
}

const render = (engine: ViewerEngine, disabled = false) => renderToStaticMarkup(
  <ModelAnimationControl locale="zh-CN" engine={engine} modelId="char" disabled={disabled} onChange={vi.fn()} />);

describe("ModelAnimationControl 根运动开关", () => {
  it("可用时渲染未选中的 switch,复位按钮因无已应用位移而禁用并带原因", () => {
    const html = render(fakeEngine());
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("根运动");
    expect(html).toContain('title="尚无已应用的位移/旋转可复位"');
  });

  it("活动片段无平移轨道时禁用并在 tooltip 给出原因", () => {
    const html = render(fakeEngine({ getModelRootMotionAvailability: () => ({ available: false, reason: "no-root-track", translation: false, rotation: true }) }));
    expect(html).toContain('title="当前片段没有根骨骼平移轨道,无位移可抽取"');
    expect(html).toMatch(/role="switch"[^>]*disabled/);
  });

  it("模型锁定时禁用开关与复位,原因为锁定", () => {
    const html = render(fakeEngine(), true);
    expect(html).toContain('title="模型已锁定,无法修改根运动"');
    expect(html).toContain('title="模型已锁定,无法复位"');
  });

  it("开启且有累计位移时显示读数,复位可用", () => {
    const html = render(fakeEngine({
      getModelRootMotionState: () => ({ enabled: true, trackResolved: true, unwrappedTime: 1, appliedTranslation: [3, 0, 4], lastTranslation: [0, 0, 0], appliedRotation: [0, 0, 0, 1], lastRotation: null }),
    }));
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Δ 5.00 m");
    expect(html).not.toContain('title="尚无已应用的位移/旋转可复位"');
  });

  it("仅绕 X 轴旋转(平移为 0)时复位可用,读数含总转角,并提示保存前复位", () => {
    const half = Math.PI / 4; // 绕 X 轴 90°
    const html = render(fakeEngine({
      getModelRootMotionState: () => ({ enabled: true, trackResolved: true, unwrappedTime: 1, appliedTranslation: [0, 0, 0], lastTranslation: null, appliedRotation: [Math.sin(half), 0, 0, Math.cos(half)], lastRotation: null }),
    }));
    expect(html).not.toContain('title="尚无已应用的位移/旋转可复位"');
    expect(html).toContain("Δ 0.00 m · 90°");
    expect(html).toContain("含根运动位移,保存前建议复位");
  });

  it("无已应用位移/旋转时不显示保存前复位提示", () => {
    expect(render(fakeEngine())).not.toContain("保存前建议复位");
  });
});