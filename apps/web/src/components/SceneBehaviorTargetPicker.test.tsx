import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SceneBehaviorTargetPicker } from "./SceneBehaviorTargetPicker";

describe("SceneBehaviorTargetPicker", () => {
  it("groups targets by scene or page and exposes searchable, named options", () => {
    const html = renderToStaticMarkup(
      <SceneBehaviorTargetPicker
        locale="zh-CN"
        value={{ kind: "component", id: "widget-1" }}
        targets={[
          { id: "pump-1", name: "循环泵", kind: "object", context: "泵房场景" },
          { id: "widget-1", name: "压力趋势", kind: "component", context: "运行总览" },
        ]}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("搜索脚本挂载目标");
    expect(html).toContain("泵房场景");
    expect(html).toContain("运行总览");
    expect(html).toContain("二维资源");
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain("二维组件");
  });

  it("does not disguise a deleted attachment as a scene-level behavior", () => {
    const html = renderToStaticMarkup(
      <SceneBehaviorTargetPicker
        locale="zh-CN"
        value={{ kind: "object", id: "retired-pump" }}
        targets={[]}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("retired-pump");
    expect(html).toContain("目标已失效");
    expect(html).toContain('aria-selected="false"');
  });
});
