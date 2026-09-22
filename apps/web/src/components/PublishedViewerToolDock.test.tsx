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
