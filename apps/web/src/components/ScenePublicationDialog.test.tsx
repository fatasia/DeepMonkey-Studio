import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScenePublicationDialog } from "./ScenePublicationDialog";

describe("ScenePublicationDialog", () => {
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
    expect(html).toContain("请先在云渲染设置完成全局配置");
    expect(html).toContain("允许访客使用适应全部、漫游、测量、剖切、爆炸和场景信息");
    expect(html).toContain("只影响发布浏览页，不开放模型编辑能力");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });
});
