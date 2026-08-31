import { renderToStaticMarkup } from "react-dom/server";
import { Box, LayoutTemplate, Upload } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { EditorEmptyState } from "./EditorEmptyState";

describe("EditorEmptyState", () => {
  it("presents one clear primary path and a secondary alternative", () => {
    const primary = vi.fn();
    const secondary = vi.fn();
    const html = renderToStaticMarkup(
      <EditorEmptyState
        icon={<Box />}
        title="还没有场景对象"
        description="导入模型或创建基础元素开始构建场景"
        primaryAction={{ label: "导入模型", icon: <Upload />, onClick: primary }}
        secondaryAction={{ label: "创建方盒", icon: <LayoutTemplate />, onClick: secondary }}
        hint="之后仍可修改"
        variant="panel"
        displayScale={2}
      />,
    );

    expect(html).toContain("还没有场景对象");
    expect(html).toContain('class="primary"');
    expect(html).toContain("导入模型");
    expect(html).toContain("创建方盒");
    expect(html).toContain("之后仍可修改");
    expect(html).toContain("--editor-empty-scale:2");
  });
});
