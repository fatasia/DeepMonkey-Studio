import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SceneAnimationState } from "@bim-studio/contracts";
import { SceneTimelinePanel } from "./SceneTimelinePanel";
import type { ViewerEngine } from "../viewer/ViewerEngine";

const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };

function animation(overrides: Partial<SceneAnimationState> = {}): SceneAnimationState {
  return { duration: 10, loop: true, camera: [], models: [], ...overrides };
}

function renderPanel(overrides: Partial<SceneAnimationState> = {}, props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <SceneTimelinePanel
      locale="zh-CN"
      animation={animation(overrides)}
      currentTime={0}
      playing={false}
      selectedObjectName={undefined}
      selectedObjectLocked={false}
      modelNames={new Map()}
      onClose={vi.fn()}
      onPlayPause={vi.fn()}
      onSeek={vi.fn()}
      onChange={vi.fn()}
      onRecordCamera={vi.fn()}
      onRecordObject={vi.fn()}
      onDeleteFrame={vi.fn()}
      {...props}
    />,
  );
}

describe("SceneTimelinePanel 导演台键盘流与巡检入口", () => {
  it("无相机路径时巡检按钮禁用并在提示中说明一键巡检语义", () => {
    const html = renderPanel();
    expect(html).toContain("timeline-patrol");
    expect(html).toMatch(/timeline-patrol[^>]*disabled/);
    expect(html).toContain("一键巡检：从头播放相机路径");
  });

  it("相机路径满两帧时巡检按钮启用", () => {
    const html = renderPanel({
      camera: [
        { id: "k1", time: 0, camera: { position: { x: 0, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" } },
        { id: "k2", time: 4, camera: { position: { x: 4, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" } },
      ],
    });
    expect(html).toContain("timeline-patrol");
    expect(html).not.toMatch(/timeline-patrol[^>]*disabled/);
  });

  it("空态引导写明 K 打帧与空格播放的快捷键动线", () => {
    const html = renderPanel();
    expect(html).toContain("K 记录相机帧");
    expect(html).toContain("空格播放");
    expect(html).toContain("按 K");
  });

  it("空态引导不重复旧文案且面板保留可缩放容器", () => {
    const html = renderPanel();
    expect(html).toContain("timeline-panel-resizable");
    expect(html).not.toContain("选择一个场景对象后可记录对象轨道");
  });

  it("已选对象时引导切换为对象名与对象帧动线", () => {
    const html = renderPanel({}, { selectedObjectName: "循环泵 P-101" });
    expect(html).toContain("已选择：循环泵 P-101");
    expect(html).toContain("K 打对象帧");
  });

  it("关键帧标记保留拖拽与删除语义（title 含时间）", () => {
    const html = renderPanel({
      models: [{ id: "m1", time: 2.5, modelId: "pump", transform }],
    }, { modelNames: new Map([["pump", "循环泵"]]) });
    expect(html).toContain("timeline-marker");
    expect(html).toContain("循环泵关键帧 2.50 秒");
  });
});
