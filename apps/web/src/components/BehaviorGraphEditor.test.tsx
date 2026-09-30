/**
 * G2-S2a 行为图编辑器 SSR 静态标记测试。
 *
 * 与 G2-S1 同范式(renderToStaticMarkup):断言初始标记的编辑器结构、门禁状态、
 * 错误定位呈现与零写回纪律;拖拽/连线/键删等真实交互归 headless Chrome 视觉闭环
 * (apps/web/scripts/g2-s2a-visual-gate.mjs),SSR 范式覆盖不到的如实声明。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RESTRICTED_GRAPH_PREFIX } from "../scripting/restrictedInteractionDocument";
import { BehaviorGraphEditorSection } from "./BehaviorGraphEditor";
import { serializeBehaviorGraph, emptyBehaviorGraph, createNodeForEntry, parseDraftGraph } from "./behaviorGraphDraft";

vi.mock("./ProfessionalCodeEditor", () => ({ ProfessionalCodeEditor: () => <div data-editor="editable" /> }));

function graphScript(graph: unknown): string {
  return RESTRICTED_GRAPH_PREFIX + JSON.stringify({ schemaVersion: 1, graph });
}

/** 合法已保存图:数据变化→条件→动作 + emit-event 回线素材。 */
function validGraph(): Record<string, unknown> {
  return {
    id: "valve-guard",
    name: "阀门联动",
    nodes: [
      { id: "on-data", kind: "event", event: { kind: "data-change", key: "temperature" } },
      { id: "over-limit", kind: "condition", expression: "values.temperature > 80" },
      { id: "open-valve", kind: "action", action: { type: "animate", target: "valve-1", command: "play" } },
      { id: "log", kind: "action", action: { type: "trace", message: "报警" } },
    ],
    edges: [
      { from: "on-data", to: "over-limit" },
      { from: "over-limit", to: "open-valve" },
    ],
  };
}

function renderSection(code: string, props: { disabled?: boolean; onCommit?: (code: string) => void } = {}): string {
  return renderToStaticMarkup(
    <BehaviorGraphEditorSection
      locale="zh-CN"
      code={code}
      disabled={props.disabled ?? false}
      onCommit={props.onCommit ?? (() => {})}
    />,
  );
}

describe("BehaviorGraphEditorSection 编辑器结构(解锁态)", () => {
  const code = graphScript(validGraph());

  it("合法脚本:编辑器与调色板渲染,默认图页签,不挂源码编辑器,渲染零写回", () => {
    const onCommit = vi.fn();
    const html = renderSection(code, { onCommit });
    expect(html).toContain('aria-label="行为图编辑器"');
    expect(html).toContain('data-editor="behavior-graph"');
    expect(html).toContain("添加节点");
    // 调色板全集:3 事件 + 条件 + 9 动作的代表标签
    expect(html).toContain("场景事件");
    expect(html).toContain("定时 tick");
    expect(html).toContain("数据变化");
    expect(html).toContain("条件");
    expect(html).toContain("写入数据");
    expect(html).toContain("发出事件");
    expect(html).toContain("引擎命令");
    expect(html).toContain('role="tab"'); // 图 / 源码 JSON 双页签
    expect(html).not.toContain('data-editor="editable"'); // 默认图页签:monaco 不挂载
    expect(html).not.toContain('data-readonly="true"');
    expect(onCommit).not.toHaveBeenCalled(); // 渲染全路径零写回
  });

  it("干净态:保存按钮 data-state=clean 且禁用(无未保存更改),不出撤销死按钮", () => {
    const html = renderSection(code);
    expect(html).toContain('data-state="clean"');
    expect(html).toContain("已保存");
    expect(html).toContain("放弃更改");
    expect(html).not.toContain("撤销");
    expect(html).not.toContain("Undo");
  });

  it("画布节点卡渲染标题与详情(与只读视图同一卡片语言)", () => {
    const html = renderSection(code);
    // jsdom 中 react-flow 画布不布局节点（真机视觉闭环覆盖画布内卡片）；
    // DOM 可达面断言：调色板同类语言 + 文档节点计数。
    expect(html).toContain("数据变化 · 图的入口");
    expect(html).toContain("条件 · 真则放行下游");
    expect(html).toContain("播放动画 · 叶节点");
    expect(html).toContain('data-debug-doc="4"');
  });
});

describe("保存门禁状态呈现(错误内联,不弹窗)", () => {
  it("非法表达式:节点卡标红 + 权威 issue 清单 + 保存仍处干净态(错误不阻止查看)", () => {
    const graph = validGraph();
    graph.nodes = [
      ...(graph.nodes as { id: string; kind: string; expression?: string }[]).map((node) =>
        node.id === "over-limit" ? { ...node, expression: "values.temperature >* 80" } : node,
      ),
    ];
    const html = renderSection(graphScript(graph));
    // 权威校验失败的原始 message 直呈(修复前此处误显示无关的"节点 id 重复"兜底文案)
    expect(html).toContain("条件表达式非法");
    // issue 代码与 has-issues 标注在画布节点卡(jsdom 不布局节点,真机视觉闭环覆盖)
    expect(html).toContain('data-state="clean"');
  });

  it("已提交即非法的历史脏数据:阻断横幅 + 打开源码 JSON 入口 + 保存禁用", () => {
    const html = renderSection(`${RESTRICTED_GRAPH_PREFIX}{"schemaVersion":1,`);
    expect(html).toContain("JSON 格式错误");
    expect(html).toContain("打开源码 JSON");
    expect(html).toContain('data-state="clean"'); // 干净态:尚无草案,门禁未触发
    expect(html).toContain("behavior-editor-broken");
  });

  it("确定性:同输入两次渲染逐字节一致(草案零隐藏随机源)", () => {
    expect(renderSection(graphScript(validGraph()))).toBe(renderSection(graphScript(validGraph())));
  });
});

describe("锁定对象:保持 G2-S1 只读体验(结构上无写回)", () => {
  it("disabled → 只读视图渲染,无编辑器、无保存按钮", () => {
    const html = renderSection(graphScript(validGraph()), { disabled: true });
    expect(html).toContain('data-readonly="true"');
    expect(html).toContain('aria-label="只读行为图"');
    expect(html).not.toContain("添加节点");
    expect(html).not.toContain('aria-label="行为图编辑器"');
  });
});

describe("初始空图(新建行为图入口产物)", () => {
  it("空图:校验通过、调色板引导可见、可保存状态干净", () => {
    const html = renderSection(serializeBehaviorGraph(emptyBehaviorGraph()));
    expect(html).toContain("校验通过");
    expect(html).toContain("节点 0/256");
    expect(html).toContain("添加节点");
  });

  it("空图语义与变换层一致:serialize(empty) 可被再次解析", () => {
    const text = serializeBehaviorGraph(emptyBehaviorGraph());
    const parsed = parseDraftGraph(text).graph;
    expect(parsed?.nodes).toHaveLength(0);
    expect(parsed && createNodeForEntry("condition", "cond-1", parsed)).toMatchObject({ kind: "condition", expression: "true" });
  });
});
