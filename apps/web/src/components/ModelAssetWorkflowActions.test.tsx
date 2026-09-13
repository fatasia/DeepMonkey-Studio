import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModelAssetWorkflowActions } from "./ModelAssetWorkflowActions";

describe("optimizer scene return action", () => {
  it("allows saving and returning directly after output is ready", () => {
    const html = renderToStaticMarkup(<ModelAssetWorkflowActions locale="zh-CN" busy={false} canSave onReturn={vi.fn()} onSaveAndReturn={vi.fn()} />);
    expect(html).toContain("插入并返回场景");
    expect(html).not.toContain('disabled=""');
  });
  it("keeps unavailable output disabled and explains the quality gate", () => {
    const html = renderToStaticMarkup(<ModelAssetWorkflowActions locale="zh-CN" busy={false} canSave={false} blockReason="请先确认质量检查" onReturn={vi.fn()} />);
    expect(html).toContain('class="primary" disabled=""');
    expect(html).toContain("请先确认质量检查");
  });
  it("labels an originating scene instance as an in-place apply operation", () => {
    const html = renderToStaticMarkup(<ModelAssetWorkflowActions locale="zh-CN" busy={false} savedModelId="optimized" returnMode="replace" onReturn={vi.fn()} />);
    expect(html).toContain("应用优化并返回场景");
    expect(html).toContain("名称、位姿与绑定保留");
    expect(html).not.toContain("插入并返回场景");
  });
});
