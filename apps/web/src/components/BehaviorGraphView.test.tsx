import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RESTRICTED_GRAPH_PREFIX } from "../scripting/restrictedInteractionDocument";
import { BehaviorGraphView } from "./BehaviorGraphView";

function graphScript(graph: unknown): string {
  return RESTRICTED_GRAPH_PREFIX + JSON.stringify({ schemaVersion: 1, graph });
}

/** 与投影单测同构的最小合法图(含 emit-event 回线)。 */
function validGraph(): Record<string, unknown> {
  return {
    id: "valve-guard",
    name: "阀门联动",
    nodes: [
      { id: "on-data", kind: "event", event: { kind: "data-change", key: "temperature" } },
      { id: "on-alarm", kind: "event", event: { kind: "scene-event", name: "alarm" } },
      { id: "tick", kind: "event", event: { kind: "tick", intervalMs: 1_000 } },
      { id: "over-limit", kind: "condition", expression: "values.temperature > 80" },
      { id: "open-valve", kind: "action", action: { type: "animate", target: "valve-1", command: "play" } },
      { id: "heartbeat", kind: "action", action: { type: "emit-event", name: "alarm" } },
      { id: "log", kind: "action", action: { type: "trace", message: "报警" } },
    ],
    edges: [
      { from: "on-data", to: "over-limit" },
      { from: "over-limit", to: "open-valve" },
      { from: "tick", to: "heartbeat" },
      { from: "on-alarm", to: "log" },
    ],
  };
}

describe("BehaviorGraphView 只读渲染(SSR 静态标记)", () => {
  it("合法图:只读标记、校验通过与预算信息、三类节点卡、回线边样式齐全,且无编辑器", () => {
    const html = renderToStaticMarkup(<BehaviorGraphView locale="zh-CN" code={graphScript(validGraph())} />);
    expect(html).toContain('aria-label="只读行为图"');
    expect(html).toContain('data-readonly="true"');
    expect(html).toContain("校验通过");
    expect(html).toContain("20,000"); // maxStepsPerDispatch = 20_000 步/派发
    expect(html).toContain("节点 7/256");
    expect(html).toContain("边 4/1024");
    expect(html).toContain("最长路径 2/16");
    expect(html).toContain("事件 · 数据变化");
    expect(html).toContain("事件 · 场景事件");
    expect(html).toContain("条件");
    expect(html).toContain("动作 · emit-event");
    // 注:React Flow 边在客户端完成节点测量后才渲染,SSR 静态标记断言不到边 SVG;
    // 回线边的存在性与样式路由由投影单测覆盖(behaviorGraphProjection.test.ts),边渲染归浏览器视觉闭环。
    expect(html).not.toContain("data-editor");
  });

  it("确定性:同输入两次渲染输出逐字节一致", () => {
    const code = graphScript(validGraph());
    expect(renderToStaticMarkup(<BehaviorGraphView locale="zh-CN" code={code} />))
      .toBe(renderToStaticMarkup(<BehaviorGraphView locale="zh-CN" code={code} />));
  });

  it("环:图级问题进清单(code 徽标),环上节点标 warning 描边", () => {
    const graph = validGraph();
    graph.edges = [...(graph.edges as unknown[]), { from: "over-limit", to: "on-data" }];
    const html = renderToStaticMarkup(<BehaviorGraphView locale="zh-CN" code={graphScript(graph)} />);
    expect(html).toContain("校验未通过");
    expect(html).toContain("cycle");
    expect(html).toContain("is-flagged");
  });

  it("动作参数非法:issue 定位到动作节点(徽标 + 悬停 title)", () => {
    const graph = {
      id: "bad-color",
      name: "坏颜色",
      nodes: [
        { id: "evt", kind: "event", event: { kind: "scene-event", name: "go" } },
        { id: "paint", kind: "action", action: { type: "set-color", target: "wall-1", color: "red" } },
      ],
      edges: [{ from: "evt", to: "paint" }],
    };
    const html = renderToStaticMarkup(<BehaviorGraphView locale="zh-CN" code={graphScript(graph)} />);
    expect(html).toContain("has-issues");
    expect(html).toContain("#RRGGBB"); // issue message 透传进 title 悬停
    expect(html).toContain("invalid-action"); // 节点级 issue 进入权威清单(带 code 徽标)
  });

  it("边引用缺失节点:该边不进画布,issue 留在清单;未知节点不渲染", () => {
    const graph = validGraph();
    graph.edges = [{ from: "on-data", to: "ghost" }, ...(graph.edges as unknown[])];
    const html = renderToStaticMarkup(<BehaviorGraphView locale="zh-CN" code={graphScript(graph)} />);
    expect(html).toContain("unknown-node-ref");
    expect(html).toContain("边终点 “ghost” 不存在"); // 边级 issue 进入权威清单
    const nodeIds = [...html.matchAll(/data-testid="rf__node-([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(nodeIds)).toEqual(new Set(["on-data", "on-alarm", "tick", "over-limit", "open-valve", "heartbeat", "log"])); // ghost 不是节点
  });

  it("文档级解析失败:横幅透传权威 message,不渲染节点", () => {
    const html = renderToStaticMarkup(<BehaviorGraphView locale="zh-CN" code={`${RESTRICTED_GRAPH_PREFIX}{not-json`} />);
    expect(html).toContain("不会回退可信 JS");
    expect(html).not.toContain("behavior-graph-card");
  });
});
