import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PublishedViewerObjectPanel } from "./PublishedViewerObjectPanel";

describe("PublishedViewerObjectPanel", () => {
  it("提供对象查看、可见性和隔离，不暴露编辑命令", () => {
    const model = { id: "pump-1", name: "循环泵", kind: "model", visible: true } as never;
    const html = renderToStaticMarkup(<PublishedViewerObjectPanel
      locale="zh-CN"
      models={[model]}
      selected={model}
      properties={{ "设备编号": "P-101" }}
      isolationActive
      onSelect={vi.fn()}
      onFocus={vi.fn()}
      onVisibilityChange={vi.fn()}
      onIsolate={vi.fn()}
      onRestoreIsolation={vi.fn()}
      onShowAll={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(html).toContain("循环泵");
    expect(html).toContain("设备编号");
    expect(html).toContain("隔离");
    expect(html).not.toContain("删除");
    expect(html).not.toContain("移动");
  });
});
