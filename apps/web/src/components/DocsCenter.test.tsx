import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocsCenter } from "./DocsCenter.js";

describe("DocsCenter", () => {
  it("renders document navigation, sections and an offline version marker", () => {
    const html = renderToStaticMarkup(<DocsCenter systemName="DeepMonkey Studio" documentId="behavior-script" onNavigate={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("DeepMonkey Studio 文档");
    expect(html).toContain("返回");
    expect(html).toContain("编写和运行行为脚本");
    expect(html).toContain("创建行为脚本");
    expect(html).toContain("文档版本 2026.09");
    expect(html).toContain("本文档随客户端离线提供");
    expect(html).toContain("复制代码");
    expect(html).toContain("相邻文档");
    expect(html).toContain("aria-keyshortcuts=\"Control+K Meta+K /\"");
    expect(html.indexOf("返回")).toBeLessThan(html.indexOf("DeepMonkey Studio 文档"));
  });

  it("renders local documentation diagrams as real images", () => {
    const html = renderToStaticMarkup(<DocsCenter systemName="DeepMonkey Studio" documentId="dashboard-scene" onNavigate={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('class="docs-image"');
    expect(html).toContain('src="/docs-assets/project-to-publish-flow.svg"');
    expect(html).toContain("项目到发布的交付路径图");
    expect(html).not.toMatch(/<p[^>]*>\s*<figure/);
  });

  it("renders the API reference diagram and cloud-render troubleshooting", () => {
    const html = renderToStaticMarkup(<DocsCenter systemName="DeepMonkey Studio" documentId="api-reference" onNavigate={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('src="/docs-assets/api-call-flow.svg"');
    expect(html).toContain("直接打开根地址得到");
    expect(html).toContain("Tripo3D");
    expect(html).toContain("腾讯混元");
  });

  it("renders the Deep Engine integration and packaging guide", () => {
    const html = renderToStaticMarkup(<DocsCenter systemName="DeepMonkey Studio" documentId="deep-engine" onNavigate={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("Deep Engine");
    expect(html).toContain('src="/docs-assets/deep-engine-architecture.svg"');
    expect(html).toContain("pnpm gate:deep-engine-editor");
    expect(html).toContain("bundle:scene-viewer");
  });

  it("renders the engine SDK, design sources and benchmark evidence in the existing center", () => {
    const design = renderToStaticMarkup(<DocsCenter systemName="DeepMonkey Studio" documentId="engine-design-influences" onNavigate={() => undefined} onClose={() => undefined} />);
    expect(design).toContain("引擎借鉴与设计理念");
    expect(design).toContain("Unity");
    expect(design).toContain("Babylon.js");
    expect(design).toContain("Bevy");
    expect(design).toContain("Godot");

    const benchmark = renderToStaticMarkup(<DocsCenter systemName="DeepMonkey Studio" documentId="engine-benchmarks" onNavigate={() => undefined} onClose={() => undefined} />);
    expect(benchmark).toContain("引擎性能与画质基准");
    expect(benchmark).toContain("Three.js、Babylon.js、Unity、Bevy 0.19");
    expect(benchmark).toContain("UE 与 Godot 不参与正式基准");
    expect(benchmark).toContain("尚未形成最终胜出结论");
  });
});
