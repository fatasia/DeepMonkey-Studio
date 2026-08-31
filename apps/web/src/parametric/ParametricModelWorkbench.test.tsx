import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ParametricModelWorkbench from "./ParametricModelWorkbench";

// 该用例只验证二级工作流的信息架构，不应初始化依赖 window 的真实 API 客户端。
vi.mock("../api", () => ({ api: { uploadModel: vi.fn() } }));

describe("ParametricModelWorkbench", () => {
  it("keeps the capability as a focused secondary asset flow", () => {
    const html = renderToStaticMarkup(<ParametricModelWorkbench projectId="default" locale="zh-CN" onClose={() => undefined} onSaved={() => undefined} />);
    expect(html).toContain("参数化轻量建模");
    expect(html).toContain("不替代专业 CAD");
    expect(html).toContain("设备安装板");
    expect(html).toContain("生成预览");
    expect(html).toContain("保存为 STEP 资源");
    expect(html).toContain("AI 参数草案");
    expect(html).toContain("生成受限草案");
    expect(html).toContain("修改参数会创建新的不可变资源版本");
  });
});
