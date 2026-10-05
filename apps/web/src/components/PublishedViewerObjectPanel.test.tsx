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

  it("每个按钮都有可访问名（P2-6 同族清剿：图标按钮不得只有 title）", () => {
    const model = { id: "pump-1", name: "循环泵", kind: "model", visible: true } as never;
    const html = renderToStaticMarkup(<PublishedViewerObjectPanel
      locale="zh-CN"
      models={[model]}
      selected={undefined}
      properties={{}}
      isolationActive={false}
      onSelect={vi.fn()}
      onFocus={vi.fn()}
      onVisibilityChange={vi.fn()}
      onIsolate={vi.fn()}
      onRestoreIsolation={vi.fn()}
      onShowAll={vi.fn()}
      onClose={vi.fn()}
    />);
    const buttons = html.split(/<button\b/).slice(1)
      .map(chunk => chunk.slice(0, chunk.indexOf("</button>")));
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    const unnamed = buttons.filter(chunk => {
      const aria = / aria-label="([^"]*)"/.exec(chunk)?.[1]?.trim() ?? "";
      if (aria) return false;
      return !chunk.slice(chunk.indexOf(">") + 1).replace(/<[^>]*>/g, "").trim();
    });
    expect(unnamed).toEqual([]);
    // 显隐按钮的可访问名携带对象名,屏幕阅读器能区分不同行的同名操作。
    expect(html).toContain("aria-label=\"隐藏：循环泵\"");
    expect(html).toContain("aria-label=\"定位：循环泵\"");
    expect(html).toContain("aria-label=\"隔离：循环泵\"");
  });
});
