import { useEffect, useState, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import type { WidgetNode } from "@bim-studio/contracts";
import { useDashboardLayerDrag } from "../src/components/useDashboardLayerDrag";
import { DashboardLayerList } from "../src/components/DashboardWorkspaceLeftPanel";
import { DashboardWorkspaceProvider } from "../src/components/dashboardWorkspaceContext";
import type { DashboardWorkspaceController } from "../src/components/DashboardWorkspace";

function HookDragFixture({ actual = false }: { actual?: boolean }) {
  const [events, setEvents] = useState<string[]>([]);
  const [draggedLayerId, setDraggedLayerId] = useState<string>();
  const [layerDropTargetId, setLayerDropTargetId] = useState<string>();
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(["a"]);
  const nodes = ["a", "b"].map((id, index) => ({ id, kind: "data-widget", zIndex: 2 - index,
    frame: { x: 0, y: 0, width: 100, height: 100 }, widget: { type: "text", title: id },
  })) as WidgetNode[];
  const log = (value: string) => setEvents(previous => [...previous.slice(-59), value]);
  useEffect(() => {
    const blur = () => log("window-blur"); const focus = () => log("window-focus");
    window.addEventListener("blur", blur); window.addEventListener("focus", focus);
    return () => { window.removeEventListener("blur", blur); window.removeEventListener("focus", focus); };
  }, []);
  const options = { page: { id: "test-page", nodes }, selectedNodeIds, setDraggedLayerId, setLayerDropTargetId,
    reorderLayerByDrop: (source: string, target?: string, intent?: { position: string }) => { log(`commit:${source}:${target}:${intent?.position}`); return undefined; },
  };
  const drag = useDashboardLayerDrag(options);
  useEffect(() => { log(`state:${JSON.stringify({ draggedLayerId, layerDropTargetId, reason: drag.reason, feedback: drag.feedback })}`); },
    [draggedLayerId, layerDropTargetId, drag.reason, drag.feedback]);
  function trace(event: DragEvent, stage: string, id: string) {
    const rect = event.currentTarget.getBoundingClientRect();
    log(`${stage}:${id}:y=${Math.round(event.clientY)}:top=${Math.round(rect.top)}:h=${Math.round(rect.height)}:prevented=${event.defaultPrevented}:effect=${event.dataTransfer.dropEffect}:allowed=${event.dataTransfer.effectAllowed}:indicator=${drag.indicator(id)}`);
  }
  const controller = { ...options, draggedLayerId, layerDropTargetId, setSelectedNodeIds, locale: "zh-CN", dashboardGroups: [],
    onSelectionChange: () => undefined, onNodeInteraction: () => undefined,
  } as unknown as DashboardWorkspaceController;
  return <section style={{ marginTop: 40 }} onDragStartCapture={event => log(`capture-start:${Math.round(event.clientY)}`)}
    onDragOverCapture={event => log(`capture-over:${Math.round(event.clientY)}`)} onDropCapture={event => log(`capture-drop:${Math.round(event.clientY)}`)}
    onDragEndCapture={() => log("capture-end")}>
    <h2>{actual ? "真实 DashboardLayerList" : "真实 useDashboardLayerDrag"}</h2>
    {actual ? <DashboardWorkspaceProvider controller={controller}><DashboardLayerList /></DashboardWorkspaceProvider> : nodes.map(node =>
      <div key={node.id} draggable onDragStart={event => { drag.start(event, node.id); trace(event, "after-start", node.id); }}
        onDragOver={event => { drag.over(event, node.id); trace(event, "after-over", node.id); }}
        onDrop={event => { drag.drop(event, node.id); trace(event, "after-drop", node.id); }} onDragEnd={event => { trace(event, "before-end", node.id); drag.cancel(); }} data-layer-drop={drag.indicator(node.id)}
        style={{ padding: 24, border: "1px solid", width: 240, marginTop: 10 }}><button>Hook 图层 {node.id}</button></div>)}
    <pre aria-label={actual ? "真实目录状态" : "Hook 状态"}>{JSON.stringify({ draggedLayerId, layerDropTargetId, reason: drag.reason, feedback: drag.feedback })}</pre>
    <output style={{ display: "block", height: 150, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 11 }} aria-label={actual ? "真实目录事件" : "Hook 事件"}>{events.join("\n") || "尚无拖放事件"}</output>
  </section>;
}

function NativeEffectFixture({ transition }: { transition: boolean }) {
  const [events, setEvents] = useState<string[]>([]);
  const log = (event: DragEvent, stage: string) => setEvents(previous => [...previous.slice(-29),
    `${stage}:y=${Math.round(event.clientY)}:effect=${event.dataTransfer.dropEffect}:allowed=${event.dataTransfer.effectAllowed}:prevented=${event.defaultPrevented}`]);
  return <section style={{ marginTop: 30 }}>
    <h2>{transition ? "原生 none → move 协商" : "原生始终 move 自定义 MIME"}</h2>
    <div draggable style={{ padding: 24, border: "1px solid", width: 240 }} onDragStart={event => {
      event.dataTransfer.setData("application/x-deep-dashboard-layer", "a"); event.dataTransfer.effectAllowed = "move"; log(event, "start");
    }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = transition ? "none" : "move"; log(event, "source-over"); }}
      onDragEnd={event => log(event, "end")}><button>原生协商起点</button></div>
    <div style={{ height: 90, width: 290, border: "1px solid", marginTop: 20 }} onDragOver={event => {
      event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
      event.dataTransfer.dropEffect = transition && event.clientY < rect.top + rect.height / 2 ? "none" : "move"; log(event, "target-over");
    }} onDrop={event => { event.preventDefault(); log(event, `drop:${event.dataTransfer.getData("application/x-deep-dashboard-layer")}`); }}>目标：{transition ? "上半禁止，下半允许" : "整行允许"}</div>
    <output aria-label={transition ? "协商事件" : "固定效果事件"} style={{ display: "block", height: 150, overflow: "auto", whiteSpace: "pre-wrap" }}>{events.join("\n")}</output>
  </section>;
}

/** 开发诊断：记录浏览器真实拖放事件，区分输入工具和业务命令故障。 */
function DragBrowserFixture() {
  const [events, setEvents] = useState<string[]>([]);
  const log = (event: DragEvent, stage: string) => {
    setEvents(previous => [...previous.slice(-19), `${stage}:${Math.round(event.clientY)}`]);
  };
  return <>
    <h1>原生图层拖放诊断</h1>
    <div draggable onDragStart={event => {
      event.dataTransfer.setData("text/plain", "layer-a");
      event.dataTransfer.effectAllowed = "move";
      log(event, "start");
    }} onDragEnd={event => log(event, "end")} style={{ padding: 24, border: "1px solid", width: 240 }}>
      <button>拖动图层 A</button>
    </div>
    <div onDragOver={event => { event.preventDefault(); log(event, "over"); }}
      onDrop={event => { event.preventDefault(); log(event, `drop:${event.dataTransfer.getData("text/plain")}`); }}
      style={{ padding: 24, border: "1px solid", width: 240, marginTop: 30 }}>目标 B</div>
    <output aria-label="事件记录">{events.join("\n") || "尚无拖放事件"}</output>
    <HookDragFixture />
    <HookDragFixture actual />
    <NativeEffectFixture transition />
    <NativeEffectFixture transition={false} />
  </>;
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<DragBrowserFixture />);
