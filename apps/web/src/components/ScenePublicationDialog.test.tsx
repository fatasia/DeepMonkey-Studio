import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScenePublicationDialog } from "./ScenePublicationDialog";

describe("ScenePublicationDialog", () => {
  it("freezes every publication choice while the submitted transaction is pending", () => {
    const html = renderToStaticMarkup(<ScenePublicationDialog
      locale="zh-CN" sceneName="发布中" mode="webgl" performance="standard"
      defaultToolbarVisible cloudConfigured busy
      onModeChange={() => undefined} onPerformanceChange={() => undefined}
      onCancel={() => undefined} onPublish={() => undefined}
    />);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(html).toMatch(/<section[^>]*tabindex="-1"/);
    expect(buttons).toHaveLength(12);
    expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
  });

  it("shares the quality-preserving WebGPU policy across publication entries", () => {
    const html = renderToStaticMarkup(<ScenePublicationDialog
      locale="zh-CN"
      sceneName="产线总览"
      mode="webgpu-preferred"
      performance="standard"
      defaultToolbarVisible
      cloudConfigured={false}
      onModeChange={() => undefined}
      onPerformanceChange={() => undefined}
      onCancel={() => undefined}
      onPublish={() => undefined}
    />);

    expect(html).toContain("不支持或画质不等价时回退 WebGL 并说明原因");
    expect(html).toContain("模型几何与纹理质量不会被重写");
    expect(html).toContain("严格使用作者效果；性能不足时给出诊断，不自动进入极速模式");
    expect(html).toContain("需要管理员先完成云渲染配置");
    expect(html).toContain("允许访客使用适应全部、漫游、测量、剖切、爆炸和场景信息");
    expect(html).toContain("只影响发布浏览页，不开放模型编辑能力");
    expect(html).toContain(">WebGL<");
    expect(html).toContain(">WebGPU<");
    expect(html).toContain("高画质");
    expect(html).toContain("极速模式");
    expect(html).toContain("发布不会覆盖草稿");
    expect(html).toContain(">发布方式<");
    expect(html).toContain(">仅发布<");
    expect(html).not.toContain(">客户端打包<");
    expect(html).toContain("Three WebView");
    expect(html).toContain("Deep Native");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("shows the cloud unavailability reason inline when cloud mode is selected", () => {
    // 回归：禁用原因原来只存在于 title 悬浮，用户感知为“灰的点不了”。
    const html = renderToStaticMarkup(<ScenePublicationDialog
      locale="zh-CN"
      sceneName="产线总览"
      mode="cloud"
      performance="standard"
      defaultToolbarVisible
      cloudConfigured={false}
      cloudHint="云渲染尚未配置：需要管理员在系统设置的云渲染页完成 GPU Worker 配置。"
      onModeChange={() => undefined}
      onPerformanceChange={() => undefined}
      onCancel={() => undefined}
      onPublish={() => undefined}
    />);
    expect(html).toContain('role="note"');
    expect(html).toContain("云渲染尚未配置");
  });
});
