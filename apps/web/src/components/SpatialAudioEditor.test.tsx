import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ViewerEngineContract } from "../viewer/viewerEngineContract";
import { SpatialAudioEditor } from "./SpatialAudioEditor";

describe("SpatialAudioEditor", () => {
  it("renders persisted playback and distance controls", () => {
    const engine = {
      getSpatialAudioState: () => ({
        enabled: true,
        url: "/assets/audio/motor.ogg",
        autoplay: true,
        loopMode: "once" as const,
        muted: false,
        volume: 0.7,
        refDistance: 2,
        maxDistance: 50,
        rolloffFactor: 1,
      }),
      setSpatialAudioState: vi.fn(),
      controlSpatialAudio: vi.fn(),
    } as unknown as ViewerEngineContract;

    const html = renderToStaticMarkup(
      <SpatialAudioEditor locale="zh-CN" engine={engine} modelId="motor-1" disabled={false} onChange={vi.fn()} />,
    );

    expect(html).toContain("空间音频");
    expect(html).toContain("自动播放");
    expect(html).toContain("播放一次");
    expect(html).toContain("起始衰减距离");
    expect(html).toContain("最大距离");
    expect(html).toContain("重播");
    expect(html).toContain("首次点击三维视口后解锁声音");
  });
});
