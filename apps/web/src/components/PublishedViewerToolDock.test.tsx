import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PublishedViewerToolDock } from "./PublishedViewerToolDock";

describe("PublishedViewerToolDock", () => {
  it("只暴露发布浏览的工程查看能力", () => {
    const html = renderToStaticMarkup(<PublishedViewerToolDock
      locale="zh-CN"
      open
      navigationMode="orbit"
      measureEnabled={false}
      clippingEnabled
      explosionActive={false}
      avatarVisible={false}
      infoEnabled={false}
      objectPanelOpen={false}
      fitSelectedEnabled
      onOpenChange={vi.fn()}
      onFitAll={vi.fn()}
      onFitSelected={vi.fn()}
      onNavigationChange={vi.fn()}
      onMeasurementToggle={vi.fn()}
      onClippingToggle={vi.fn()}
      onExplosionToggle={vi.fn()}
      onAvatarToggle={vi.fn()}
      onInfoToggle={vi.fn()}
      onObjectPanelOpenChange={vi.fn()}
      onStandardView={vi.fn()}
      onFullscreen={vi.fn()}
      onStartXR={vi.fn()}
    />);

    expect(html).toContain("测量标尺");
    expect(html).toContain("剖切查看");
    expect(html).toContain("模型爆炸");
    expect(html).toContain("对象与属性");
    expect(html).toContain("更多视图工具");
    expect(html).toContain("适应选中模型");
    expect(html).toContain("适应全部");
    expect(html).not.toContain("移动");
    expect(html).not.toContain("材质");
  });

  it("XR 不可用时不渲染不可操作的按钮", () => {
    const html = renderToStaticMarkup(<PublishedViewerToolDock
      locale="zh-CN" open navigationMode="orbit" measureEnabled={false} clippingEnabled={false}
      explosionActive={false} avatarVisible={false} infoEnabled={false} objectPanelOpen={false}
      xrUnavailableReason="当前设备不支持 WebXR" onOpenChange={vi.fn()} onFitAll={vi.fn()}
      onNavigationChange={vi.fn()} onMeasurementToggle={vi.fn()} onClippingToggle={vi.fn()}
      onExplosionToggle={vi.fn()} onAvatarToggle={vi.fn()} onInfoToggle={vi.fn()}
      onObjectPanelOpenChange={vi.fn()} onStandardView={vi.fn()} onFullscreen={vi.fn()}
      onStartXR={vi.fn()} />);
    expect(html).not.toContain("进入 VR");
    expect(html).not.toContain("进入 AR");
  });

  it("快照未编译剖切能力时隐藏剖切按钮，其余工具不受对象级降级清单语义影响", () => {
    const html = renderToStaticMarkup(<PublishedViewerToolDock
      locale="zh-CN" open navigationMode="orbit" measureEnabled={false} clippingEnabled={false}
      explosionActive={false} avatarVisible={false} infoEnabled={false} objectPanelOpen={false}
      toolsAvailability={{ clippingAvailable: false, physicsAvailable: false }}
      onOpenChange={vi.fn()} onFitAll={vi.fn()} onNavigationChange={vi.fn()}
      onMeasurementToggle={vi.fn()} onClippingToggle={vi.fn()} onExplosionToggle={vi.fn()}
      onAvatarToggle={vi.fn()} onInfoToggle={vi.fn()} onObjectPanelOpenChange={vi.fn()}
      onStandardView={vi.fn()} onFullscreen={vi.fn()} onStartXR={vi.fn()} />);
    expect(html).not.toContain("剖切查看");
    // 无法由快照形状诚实判定的工具保持显示：测量（measurements 只是已有数据）、爆炸（纯运行时能力）。
    expect(html).toContain("测量标尺");
    expect(html).toContain("模型爆炸");
  });

  it("快照携带剖切字段时剖切按钮正常渲染", () => {
    const html = renderToStaticMarkup(<PublishedViewerToolDock
      locale="zh-CN" open navigationMode="orbit" measureEnabled={false} clippingEnabled
      explosionActive={false} avatarVisible={false} infoEnabled={false} objectPanelOpen={false}
      toolsAvailability={{ clippingAvailable: true, physicsAvailable: false }}
      onOpenChange={vi.fn()} onFitAll={vi.fn()} onNavigationChange={vi.fn()}
      onMeasurementToggle={vi.fn()} onClippingToggle={vi.fn()} onExplosionToggle={vi.fn()}
      onAvatarToggle={vi.fn()} onInfoToggle={vi.fn()} onObjectPanelOpenChange={vi.fn()}
      onStandardView={vi.fn()} onFullscreen={vi.fn()} onStartXR={vi.fn()} />);
    expect(html).toContain("剖切查看");
  });
});

describe("PublishedViewerToolDock accessible names (P2-6)", () => {
  /** 按 </button> 切出每个按钮的属性+内容段；工具坞内按钮无嵌套。 */
  function buttonChunks(html: string): string[] {
    return html.split(/<button\b/).slice(1)
      .map(chunk => chunk.slice(0, chunk.indexOf("</button>")));
  }
  /** 可访问名:显式 aria-label 优先,其次元素内可见文本;两者皆空即 a11y 缺陷。 */
  function accessibleName(chunk: string): string {
    const aria = / aria-label="([^"]*)"/.exec(chunk)?.[1]?.trim() ?? "";
    if (aria) return aria;
    return chunk.slice(chunk.indexOf(">") + 1).replace(/<[^>]*>/g, "").trim();
  }
  const base = {
    locale: "zh-CN" as const, navigationMode: "orbit" as const, measureEnabled: false,
    clippingEnabled: false,
    explosionActive: false, avatarVisible: false, infoEnabled: false, objectPanelOpen: false,
    onOpenChange: vi.fn(), onFitAll: vi.fn(), onNavigationChange: vi.fn(),
    onMeasurementToggle: vi.fn(), onClippingToggle: vi.fn(), onExplosionToggle: vi.fn(),
    onAvatarToggle: vi.fn(), onInfoToggle: vi.fn(), onObjectPanelOpenChange: vi.fn(),
    onStandardView: vi.fn(), onFullscreen: vi.fn(), onStartXR: vi.fn(),
  };

  it.each([
    ["expanded with clipping", { open: true, clippingEnabled: true, toolsAvailability: { clippingAvailable: true, physicsAvailable: false } as const }],
    ["collapsed", { open: false, clippingEnabled: false, toolsAvailability: { clippingAvailable: true, physicsAvailable: false } as const }],
    ["expanded without clipping capability", { open: true, clippingEnabled: false, toolsAvailability: { clippingAvailable: false, physicsAvailable: false } as const }],
  ] as const)("every toolbar button has an accessible name when %s", (_case, overrides) => {
    const html = renderToStaticMarkup(<PublishedViewerToolDock {...base} {...overrides} />);
    const buttons = buttonChunks(html);
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    const unnamed = buttons.map((chunk, index) => ({ name: accessibleName(chunk), index }))
      .filter(item => !item.name);
    expect(unnamed).toEqual([]);
  });

  it("collapsed dock exposes the toggle by name and keeps every button named", () => {
    // moreOpen 是内部 state,静态渲染从收起起步;收起态只剩切换按钮,必须自带可访问名。
    const html = renderToStaticMarkup(<PublishedViewerToolDock {...base} open={false}
      toolsAvailability={{ clippingAvailable: true, physicsAvailable: false }} />);
    expect(html).toContain("aria-label=\"展开浏览工具\"");
    expect(buttonChunks(html).every(chunk => accessibleName(chunk))).toBe(true);
  });

  it("expanded dock toggle switches to the collapse name", () => {
    const html = renderToStaticMarkup(<PublishedViewerToolDock {...base} open
      toolsAvailability={{ clippingAvailable: true, physicsAvailable: false }} />);
    expect(html).toContain("aria-label=\"收起浏览工具\"");
  });
});
