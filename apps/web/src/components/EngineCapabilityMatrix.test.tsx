import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineCapabilityMatrix } from "./EngineCapabilityMatrix";

/** 静态渲染整页:数据全部来自 contracts 登记表单源派生,断言页面结构与诚实条款。 */
function renderMatrix(): string {
  return renderToStaticMarkup(<EngineCapabilityMatrix />);
}

describe("EngineCapabilityMatrix", () => {
  it("renders renderer domains with both end statuses and evidence paths from the manifest", () => {
    const html = renderMatrix();
    expect(html).toContain("渲染引擎能力");
    expect(html).toContain("Studio(Web)");
    expect(html).toContain("Native(Rust)");
    expect(html).toContain("证据");
    // 单源派生:登记表已知行出现在页面上(域标题 + 行 id)。
    expect(html).toContain("全局光照(GI)");
    expect(html).toContain("阴影");
    expect(html).toContain("光线追踪");
    expect(html).toContain("Deep 2D");
    // pill 的 title 携带 support/reason 原文(可审计,不是营销文案)。
    expect(html).toMatch(/support=supported · reason=/);
  });

  it("renders format support rows with direction, scope and status from the catalog", () => {
    const html = renderMatrix();
    expect(html).toContain("格式支持");
    expect(html).toContain("扩展名");
    // 目录单源当前全部 direction=import、验证止步 fixture-validated——断言对齐真实登记面。
    expect(html).toContain("导入");
    expect(html).toContain("可用(样例验证)");
    expect(html).toContain("内置");
  });

  it("renders summary chips with manifest-derived counts", () => {
    const html = renderMatrix();
    expect(html).toMatch(/双端完整 \d+\/\d+/);
    expect(html).toMatch(/规划中 \d+/);
    expect(html).toMatch(/生产可用 \d+\/\d+/);
  });

  it("keeps the honest physics empty state instead of fabricated rows", () => {
    const html = renderMatrix();
    expect(html).toContain("物理能力");
    expect(html).toContain("物理能力尚未建立双端公开登记表");
  });

  it("renders the status legend and registry discipline footnote", () => {
    const html = renderMatrix();
    expect(html).toContain("状态图例");
    expect(html).toContain("登记纪律");
    expect(html).toContain("对拍测试");
  });
});
