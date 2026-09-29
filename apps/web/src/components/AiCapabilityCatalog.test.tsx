import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiCapabilityExamples, capabilityExampleQuestion } from "./AiCapabilityCatalog";

/** T9（审计 §二 2.4）：能力目录"能为我做什么"示例问题映射。 */
describe("capabilityExampleQuestion（T9 示例问题映射）", () => {
  it("data.* 命名空间给出受控问数式问句并要求证据来源", () => {
    const question = capabilityExampleQuestion({ id: "data.query.read", label: "数据查询", kind: "read" }, "zh-CN");
    expect(question).toContain("数据查询");
    expect(question).toContain("证据来源");
  });

  it("action 型能力提示先说明参数与影响范围、等确认（写入纪律前置）", () => {
    const question = capabilityExampleQuestion({ id: "scene.apply", label: "场景写入", kind: "action" }, "zh-CN");
    expect(question).toContain("改变状态");
    expect(question).toContain("等");
  });

  it("只读能力给出分析式问句且要求给出证据", () => {
    const question = capabilityExampleQuestion({ id: "sim.analyze", label: "仿真分析", kind: "read" }, "zh-CN");
    expect(question).toContain("仿真分析");
    expect(question).toContain("证据");
  });

  it("英文语言不残留中文", () => {
    const question = capabilityExampleQuestion({ id: "sim.analyze", label: "Sim analyze", kind: "read" }, "en-US");
    expect(question).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe("AiCapabilityExamples（T9 示例问题区，纯视图）", () => {
  const capabilities = [
    { id: "data.query.read", label: "数据查询", kind: "read" },
    { id: "sim.analyze", label: "仿真分析", kind: "read" },
  ];

  it("渲染示例问题钮并可点（有 onAskExample）", () => {
    const html = renderToStaticMarkup(
      <AiCapabilityExamples locale="zh-CN" capabilities={capabilities} onAskExample={vi.fn()} />,
    );
    expect(html).toContain("能为我做什么");
    expect(html).toContain("能力示例问题");
    expect(html).toContain("数据查询");
    expect(html).not.toContain("disabled");
  });

  it("缺省 onAskExample 或 disabled 时按钮禁用（不出现不可兑现的可点承诺）", () => {
    const withoutHandler = renderToStaticMarkup(<AiCapabilityExamples locale="zh-CN" capabilities={capabilities} />);
    const busy = renderToStaticMarkup(
      <AiCapabilityExamples locale="zh-CN" capabilities={capabilities} onAskExample={vi.fn()} disabled />,
    );
    expect(withoutHandler).toContain("disabled");
    expect(busy).toContain("disabled");
  });

  it("超过 4 项能力只取样前 4 条示例（信息密度纪律，防刷屏）", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ id: `cap.${index}`, label: `能力${index}`, kind: "read" }));
    const html = renderToStaticMarkup(<AiCapabilityExamples locale="zh-CN" capabilities={many} onAskExample={vi.fn()} />);
    expect(html).toContain("能力3");
    expect(html).not.toContain("能力4");
    expect(html).not.toContain("能力5");
  });
});
