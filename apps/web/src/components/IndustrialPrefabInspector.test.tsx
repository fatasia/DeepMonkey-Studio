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
});
