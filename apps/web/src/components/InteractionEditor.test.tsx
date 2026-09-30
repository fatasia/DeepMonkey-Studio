import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createInteractionScript } from "../interactionState";
import { RESTRICTED_GRAPH_PREFIX } from "../scripting/restrictedInteractionDocument";
import { InteractionEditor } from "./InteractionEditor";

vi.mock("./ProfessionalCodeEditor", () => ({ ProfessionalCodeEditor: () => <div data-editor="editable" /> }));

describe("locked interaction inspection", () => {
  const target = { kind: "object" as const, modelId: "locked-model" };
  const script = { ...createInteractionScript(target, "click"), code: "api.log('existing script');" };
  it("keeps existing scripts inspectable while disabling mutation and execution controls", () => {
    const html = renderToStaticMarkup(<InteractionEditor locale="zh-CN" target={target} targetName="锁定模型"
      interactions={[script]} disabled onChange={vi.fn()} onTest={vi.fn()} />);
    expect(html).toContain('<fieldset class="interaction-code-editor" disabled=""');
    expect(html).toContain('aria-label="只读事件脚本"');
    expect(html).toContain("existing script");
    expect(html).not.toContain('data-editor="editable"');
    expect(html).toContain('<button disabled=""');
  });
  it("retains the editable code editor for unlocked objects", () => {
    const html = renderToStaticMarkup(<InteractionEditor locale="zh-CN" target={target} targetName="模型"
      interactions={[script]} onChange={vi.fn()} onTest={vi.fn()} />);
    expect(html).toContain('data-editor="editable"');
    expect(html).not.toContain('<fieldset class="interaction-code-editor" disabled');
  });
});

describe("restricted graph read-only tab (G2-S1)", () => {
  const target = { kind: "object" as const, modelId: "graph-model" };
  const validGraph = {
    schemaVersion: 1,
    graph: {
      id: "valve-guard",
      name: "阀门联动",
      nodes: [
        { id: "on-data", kind: "event", event: { kind: "data-change", key: "temperature" } },
        { id: "over-limit", kind: "condition", expression: "values.temperature > 80" },
        { id: "open-valve", kind: "action", action: { type: "animate", target: "valve-1", command: "play" } },
      ],
      edges: [
        { from: "on-data", to: "over-limit" },
        { from: "over-limit", to: "open-valve" },
      ],
    },
  };
  const restricted = { ...createInteractionScript(target, "click"), code: RESTRICTED_GRAPH_PREFIX + JSON.stringify(validGraph) };

  it("restricted 脚本默认落在行为图编辑器(双页签),渲染校验通过与预算,写回走保存门禁", () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<InteractionEditor locale="zh-CN" target={target} targetName="图模型"
      interactions={[restricted]} onChange={onChange} onTest={vi.fn()} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain("行为图");
    expect(html).toContain("源码 JSON");
    expect(html).toContain('aria-label="行为图视图"');
    expect(html).toContain("校验通过");
    expect(html).toContain("256"); // S2a 收紧后的节点预算(256)取代 G2-S1 文档期数字(20,000)
    expect(html).not.toContain('data-editor="editable"'); // 图页签默认激活:源码编辑器不渲染
    expect(onChange).not.toHaveBeenCalled(); // 渲染全路径零写回
  });

  it("非法 restricted 脚本:权威错误在图页签定位展示,数据仍零写回", () => {
    const onChange = vi.fn();
    const broken = { ...restricted, code: `${RESTRICTED_GRAPH_PREFIX}{"schemaVersion":1,"graph":{"id":"x",` };
    const html = renderToStaticMarkup(<InteractionEditor locale="zh-CN" target={target} targetName="图模型"
      interactions={[broken]} onChange={onChange} onTest={vi.fn()} />);
    expect(html).toContain("不会回退可信 JS");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("锁定检查态:restricted 脚本只提供只读图,不出可编辑通道", () => {
    const html = renderToStaticMarkup(<InteractionEditor locale="zh-CN" target={target} targetName="锁定图模型"
      interactions={[restricted]} disabled onChange={vi.fn()} onTest={vi.fn()} />);
    expect(html).toContain('aria-label="只读行为图"');
    expect(html).not.toContain('data-editor="editable"');
    expect(html).not.toContain('aria-label="只读事件脚本"'); // 图页签默认激活,pre 属于源码页签
  });

  it("非 restricted 脚本不出现图页签(既有行为不变)", () => {
    const html = renderToStaticMarkup(<InteractionEditor locale="zh-CN" target={target} targetName="模型"
      interactions={[{ ...createInteractionScript(target, "click"), code: "api.log(1);" }]} onChange={vi.fn()} onTest={vi.fn()} />);
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("只读行为图");
    expect(html).toContain("高级 JavaScript");
  });
});
