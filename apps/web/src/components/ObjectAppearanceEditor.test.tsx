import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ObjectAppearanceEditor } from "./ObjectAppearanceEditor";

describe("ObjectAppearanceEditor", () => {
  it("renders production material, texture and effect controls", () => {
    const html = renderToStaticMarkup(
      <ObjectAppearanceEditor
        locale="zh-CN"
        rendererBackend="webgl"
        disabled={false}
        material={{
          color: "#ffffff",
          roughness: 0.5,
          metalness: 0.1,
          emissive: "#000000",
          emissiveIntensity: 0,
          baseColorMapUrl: "/textures/belt.png",
          textureRepeatX: 4,
          textureRepeatY: 1.5,
          textureOffsetX: 0.25,
          textureOffsetY: -0.1,
          uvAnimation: { enabled: true, loopMode: "once", durationSeconds: 5, offsetSpeedX: 0.25, offsetSpeedY: 0, rotationSpeed: 0 },
          screen: { enabled: true, sourceType: "video", url: "/media/status.mp4", autoplay: true, loopMode: "loop", muted: true, emissiveIntensity: 1.2 },
        }}
        effects={{
          outline: false,
          glow: false,
          xray: false,
          scanline: false,
          heatmap: false,
          dissolve: 0,
          edgeLight: false,
          color: "#e0b755",
          intensity: 1,
          fire: { enabled: true, color: "#ff6a22", intensity: 2, height: 3.5, density: 1.25 },
        }}
        onMaterialChange={vi.fn()}
        onEffectsChange={vi.fn()}
        onChooseTexture={vi.fn()}
      />,
    );

    expect(html).toContain("工程塑料");
    expect(html).toContain("粗糙度 数值");
    expect(html).toContain("金属度 数值");
    expect(html).toContain("基础色贴图");
    expect(html).toContain("贴图变换");
    expect(html).toContain("环境遮蔽贴图");
    expect(html).toContain("线框");
    expect(html).toContain("高级表现");
    expect(html).toContain("扫描线");
    expect(html).toContain("火焰图层");
    expect(html).toContain("单批次轻量粒子");
    expect(html).toContain("高度");
    expect(html).toContain("密度");
    expect(html).toContain("UV 动画");
    expect(html).toContain("横向重复 U");
    expect(html).toContain("纵向重复 V");
    expect(html).toContain("横向偏移 U");
    expect(html).toContain("纵向偏移 V");
    expect(html).toContain("横向速度");
    expect(html).toContain("播放一次");
    expect(html).toContain("播放时长");
    expect(html).toContain("模型屏幕");
    expect(html).toContain("自动播放");
    expect(html).toContain("循环播放");
  });
});
