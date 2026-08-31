import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DeviceLayoutWorkbench } from "./DeviceLayoutWorkbench";

describe("DeviceLayoutWorkbench", () => {
  it("starts with a useful grid preview and explicit GeoJSON workflow", () => {
    const html = renderToStaticMarkup(<DeviceLayoutWorkbench locale="zh-CN" onApply={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("批量设备布局");
    expect(html).toContain("预览 12 台设备");
    expect(html).toContain("导入数据/GeoJSON");
    expect(html).toContain("同时创建模型标签");
    expect(html).toContain("创建 12 台设备");
  });
});
