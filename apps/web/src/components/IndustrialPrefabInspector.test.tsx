import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { IndustrialPrefabInspector } from "./IndustrialPrefabInspector";

describe("IndustrialPrefabInspector", () => {
  it("exposes route playback, points and runtime controls without JSON editing", () => {
    const engine = {
      getIndustrialPrefabState: () => ({
        definitionId: "agv.carrier",
        definitionVersion: "1.0.0",
        kind: "agv",
        parameters: { speedMps: 1.5, accelerationMps2: 0.6 },
        operatingState: "idle",
        motionRoute: {
          enabled: true,
          autoplay: false,
          points: [
            { id: "p1", position: { x: 0, y: 0, z: 0 } },
            { id: "p2", position: { x: 5, y: 0, z: 0 } },
          ],
          speedMps: 1.5,
          accelerationMps2: 0.6,
          loopMode: "once",
          orientToPath: true,
          startOffsetSeconds: 0,
        },
      }),
      setIndustrialPrefabState: vi.fn(),
      executeIndustrialPrefabAction: vi.fn(),
    } as unknown as ViewerEngine;

    const html = renderToStaticMarkup(<IndustrialPrefabInspector locale="zh-CN" engine={engine} modelId="agv-1" disabled={false} onChange={vi.fn()} />);
    expect(html).toContain("运动路线");
    expect(html).toContain("自动播放");
    expect(html).toContain("播放一次");
    expect(html).toContain("循环播放");
    expect(html).toContain("往返循环");
    expect(html).toContain("添加路线点");
    expect(html).toContain("重播");
  });

  it("renders the formal straight-road parameters through the existing property editor", () => {
    const engine = {
      getIndustrialPrefabState: () => ({
        definitionId: "road.straight",
        definitionVersion: "1.0.0",
        kind: "road",
        parameters: {
          lengthM: 20,
          carriagewayWidthM: 7,
          laneCount: 2,
          shoulderWidthM: 0.75,
          surface: "asphalt",
          marking: "center",
        },
        operatingState: "idle",
        placementPath: {
          points: [{ id: "start", position: { x: 0, y: 0, z: 0 } }, { id: "end", position: { x: 20, y: 0, z: 0 } }],
          interpolation: "linear", closed: false, snapToGround: true, seed: 42,
        },
      }),
      setIndustrialPrefabState: vi.fn(),
      executeIndustrialPrefabAction: vi.fn(),
    } as unknown as ViewerEngine;

    const html = renderToStaticMarkup(<IndustrialPrefabInspector locale="zh-CN" engine={engine} modelId="road-1" disabled={false} onChange={vi.fn()} />);
    expect(html).toContain("参数化直路");
    expect(html).toContain("道路长度");
    expect(html).toContain("车行道宽度");
    expect(html).toContain("车道数");
    expect(html).toContain("路肩宽度");
    expect(html).toContain("路面材质");
    expect(html).toContain("道路标线");
    expect(html).toContain('min="2"');
    expect(html).toContain('max="500"');
    expect(html).toContain("铺设路径");
    expect(html).toContain("平滑样条");
    expect(html).toContain("固定种子");
    // 坡度上限输入缺省展示导航同源口径（50°），作者可显式调整。
    expect(html).toContain("坡度上限");
    expect(html).toContain('value="50"');
    expect(html).toContain('max="89"');
    expect(html).toContain("添加端点");
  });
});
