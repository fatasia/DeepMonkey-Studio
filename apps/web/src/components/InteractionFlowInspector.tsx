import { Plus, Play, Trash2, Workflow } from "lucide-react";
import type {
  ApplicationDocument,
  ApplicationObjectRef,
  InteractionFlow,
  SceneInteractionActionState,
  SceneInteractionActionType,
  SceneInteractionTrigger
} from "@bim-studio/contracts";
import {
  createDeleteInteractionFlowCommand,
  createUpsertInteractionFlowCommand,
  sameObjectRef,
  type ApplicationInteractionResult,
  type StudioCommand
} from "@bim-studio/studio-core";
import { useEffect, useState } from "react";
import { translate as tr, type AppLocale } from "../i18n";
import { defaultInteractionCode } from "../interactionState";
import { ProfessionalCodeEditor } from "./ProfessionalCodeEditor";

const TRIGGERS: SceneInteractionTrigger[] = ["click", "doubleClick", "contextMenu", "pointerEnter", "pointerLeave", "load", "animationStart", "animationEnd"];
const ACTION_TYPES: SceneInteractionActionType[] = ["focus", "visibility", "color", "opacity", "animation", "cameraView", "navigateScene", "dashboard", "message", "setData", "openUrl"];
const OBJECT_ACTIONS = new Set<SceneInteractionActionType>(["focus", "visibility", "color", "opacity", "animation"]);

export function InteractionFlowInspector({ locale, application, source, onCommand, onTest }: {
  locale: AppLocale;
  application: ApplicationDocument;
  source: ApplicationObjectRef;
  onCommand: (command: StudioCommand) => void;
  onTest: (trigger: SceneInteractionTrigger) => ApplicationInteractionResult | undefined;
}) {
  const flows = application.interactions.filter((flow) => sameObjectRef(flow.source, source));
  const firstScene = application.scenes[0];
  const firstObject = firstScene ? [...firstScene.models, ...firstScene.primitives][0] : undefined;
  const [lastTest, setLastTest] = useState<ApplicationInteractionResult>();
  const sourceKey = source.kind === "object" ? `${source.sceneId}:${source.modelId}:${source.layerId ?? ""}` : `${source.kind}:${source.id}`;

  useEffect(() => setLastTest(undefined), [sourceKey]);

  function save(flow: InteractionFlow) {
    onCommand(createUpsertInteractionFlowCommand(flow.legacyScript ? {
      ...flow,
      legacyScript: { ...flow.legacyScript, script: { ...flow.legacyScript.script, name: flow.name, trigger: flow.trigger, enabled: flow.enabled } }
    } : flow));
  }

  function enableScript(flow: InteractionFlow) {
    const target = flow.source.kind === "widget"
      ? { kind: "widget" as const, widgetId: flow.source.id }
      : flow.source.kind === "object"
        ? { kind: "object" as const, modelId: flow.source.modelId, ...(flow.source.layerId ? { layerId: flow.source.layerId } : {}) }
        : undefined;
    if (!target) return;
    save({ ...flow, legacyScript: { runtime: "legacy-trusted-main-thread", script: { id: `script:${flow.id}`, name: flow.name, target, trigger: flow.trigger, enabled: flow.enabled, actions: [], code: defaultInteractionCode(flow.trigger, target.kind) } } });
  }

  function addFlow() {
    const flowId = crypto.randomUUID();
    save({
      id: flowId,
      name: tr(locale, "默认事件", "Default event"),
      source: structuredClone(source),
      trigger: "click",
      enabled: true,
      actions: [defaultAction(locale, firstObject ? "focus" : "message", application, firstScene?.id)]
    });
  }

  return <section className="interaction-flow-inspector">
    <header><span><Workflow size={14} />{tr(locale, "事件与动作", "Events & actions")}</span><small>{flows.length}</small></header>
    {flows.map((flow) => <article className="interaction-flow-card" key={flow.id}>
      <header>
        <input aria-label={tr(locale, "启用联动", "Enable interaction")} type="checkbox" checked={flow.enabled} onChange={(event) => save({ ...flow, enabled: event.target.checked })} />
        <input aria-label={tr(locale, "联动名称", "Interaction name")} defaultValue={flow.name} key={`${flow.id}:${flow.name}`} onBlur={(event) => { const name = event.currentTarget.value.trim(); if (name && name !== flow.name) save({ ...flow, name }); }} />
        <button title={tr(locale, "删除联动", "Delete interaction")} onClick={() => onCommand(createDeleteInteractionFlowCommand(flow.id))}><Trash2 size={13} /></button>
      </header>
      <label><span>{tr(locale, "触发", "Trigger")}</span><select value={flow.trigger} onChange={(event) => save({ ...flow, trigger: event.target.value as SceneInteractionTrigger })}>{TRIGGERS.map((trigger) => <option key={trigger} value={trigger}>{triggerLabel(locale, trigger)}</option>)}</select></label>
      <div className="interaction-flow-actions">
        {flow.actions.map((action) => <InteractionActionEditor key={action.id} locale={locale} application={application} action={action} onChange={(next) => save({ ...flow, actions: flow.actions.map((candidate) => candidate.id === action.id ? next : candidate) })} onDelete={() => save({ ...flow, actions: flow.actions.filter((candidate) => candidate.id !== action.id) })} />)}
      </div>
      {(flow.source.kind === "widget" || flow.source.kind === "object") && <details className="interaction-flow-script"><summary>{tr(locale, "高级脚本", "Advanced script")}<small>{flow.legacyScript ? "JavaScript · THREE" : tr(locale, "按需启用", "Optional")}</small></summary>{flow.legacyScript ? <><ProfessionalCodeEditor compact locale={locale} path={`bim-studio://application-flow/${flow.id}.js`} height={260} value={flow.legacyScript.script.code} onChange={(code) => save({ ...flow, legacyScript: { ...flow.legacyScript!, script: { ...flow.legacyScript!.script, code } } })} onRun={() => setLastTest(onTest(flow.trigger))} /><button className="interaction-flow-disable-script" onClick={() => { const { legacyScript: _legacyScript, ...withoutScript } = flow; save(withoutScript); }}>{tr(locale, "移除高级脚本", "Remove advanced script")}</button></> : <button className="interaction-flow-enable-script" onClick={() => enableScript(flow)}>{tr(locale, "启用应用级 JavaScript", "Enable app-level JavaScript")}</button>}</details>}
      <footer><button onClick={() => save({ ...flow, actions: [...flow.actions, defaultAction(locale, firstObject ? "focus" : "message", application, firstScene?.id)] })}><Plus size={12} />{tr(locale, "添加动作", "Add action")}</button><button onClick={() => setLastTest(onTest(flow.trigger))}><Play size={12} />{tr(locale, "运行测试", "Run test")}</button></footer>
    </article>)}
    {lastTest && <div className={`interaction-flow-test-result ${lastTest.matchedFlowIds.length ? "matched" : "empty"}`}><strong>{lastTest.matchedFlowIds.length ? tr(locale, "联动已执行", "Interaction executed") : tr(locale, "没有命中流程", "No flow matched")}</strong><span>{tr(locale, `${lastTest.matchedFlowIds.length} 条流程 · ${Object.keys(lastTest.variableUpdates).length} 个变量 · ${lastTest.effects.length} 个动作`, `${lastTest.matchedFlowIds.length} flows · ${Object.keys(lastTest.variableUpdates).length} variables · ${lastTest.effects.length} effects`)}</span></div>}
    {flows.length === 0 && <div className="interaction-flow-empty"><Workflow size={18} /><span>{tr(locale, "为当前组件添加二维与三维联动", "Add a 2D/3D interaction for this component")}</span></div>}
    <button className="interaction-flow-add" onClick={addFlow}><Plus size={13} />{tr(locale, "新建联动", "New interaction")}</button>
  </section>;
}

function InteractionActionEditor({ locale, application, action, onChange, onDelete }: {
  locale: AppLocale;
  application: ApplicationDocument;
  action: SceneInteractionActionState;
  onChange: (action: SceneInteractionActionState) => void;
  onDelete: () => void;
}) {
  const sceneId = action.sceneId ?? application.scenes[0]?.id ?? "";
  const scene = application.scenes.find((candidate) => candidate.id === sceneId);
  const objects = scene ? [...scene.models, ...scene.primitives] : [];
  const targetId = action.target?.modelId ?? objects[0]?.modelId ?? "";

  function changeType(type: SceneInteractionActionType) {
    onChange(defaultAction(locale, type, application, sceneId, action.id));
  }

  function changeScene(nextSceneId: string) {
    const nextScene = application.scenes.find((candidate) => candidate.id === nextSceneId);
    const firstObject = [...(nextScene?.models ?? []), ...(nextScene?.primitives ?? [])][0];
    const { target: _target, cameraViewId: _cameraViewId, ...base } = action;
    onChange({
      ...base,
      sceneId: nextSceneId,
      ...(OBJECT_ACTIONS.has(action.type) && firstObject ? { target: { kind: "object" as const, modelId: firstObject.modelId } } : {}),
      ...(action.type === "cameraView" && nextScene?.cameraViews?.[0] ? { cameraViewId: nextScene.cameraViews[0].id } : {})
    });
  }

  return <div className="interaction-flow-action">
    <div className="interaction-flow-action-head"><select aria-label={tr(locale, "动作类型", "Action type")} value={action.type} onChange={(event) => changeType(event.target.value as SceneInteractionActionType)}>{ACTION_TYPES.map((type) => <option key={type} value={type}>{actionLabel(locale, type)}</option>)}</select><button title={tr(locale, "删除动作", "Delete action")} onClick={onDelete}><Trash2 size={12} /></button></div>
    {(OBJECT_ACTIONS.has(action.type) || action.type === "cameraView" || action.type === "navigateScene") && <label><span>{tr(locale, "场景", "Scene")}</span><select value={sceneId} onChange={(event) => changeScene(event.target.value)}>{application.scenes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>}
    <label className="interaction-action-enabled"><input type="checkbox" checked={action.enabled} onChange={(event) => onChange({ ...action, enabled: event.target.checked })} />{tr(locale, "启用此动作", "Enable this action")}</label>
    {OBJECT_ACTIONS.has(action.type) && <label><span>{tr(locale, "对象", "Object")}</span><select value={targetId} onChange={(event) => onChange({ ...action, sceneId, target: { kind: "object", modelId: event.target.value } })}>{objects.map((object) => <option key={object.modelId} value={object.modelId}>{object.name}</option>)}</select></label>}
    <ActionValueEditor locale={locale} application={application} scene={scene} action={action} onChange={onChange} />
  </div>;
}

function ActionValueEditor({ locale, application, scene, action, onChange }: {
  locale: AppLocale;
  application: ApplicationDocument;
  scene: ApplicationDocument["scenes"][number] | undefined;
  action: SceneInteractionActionState;
  onChange: (action: SceneInteractionActionState) => void;
}) {
  if (action.type === "visibility") return <label><span>{tr(locale, "方式", "Mode")}</span><select value={String(action.value ?? "toggle")} onChange={(event) => onChange({ ...action, value: event.target.value })}><option value="toggle">{tr(locale, "切换显示状态", "Toggle")}</option><option value="show">{tr(locale, "显示", "Show")}</option><option value="hide">{tr(locale, "隐藏", "Hide")}</option></select></label>;
  if (action.type === "animation") return <label><span>{tr(locale, "方式", "Mode")}</span><select value={String(action.value ?? "toggle")} onChange={(event) => onChange({ ...action, value: event.target.value })}><option value="toggle">{tr(locale, "播放 / 暂停", "Play / pause")}</option><option value="play">{tr(locale, "播放", "Play")}</option><option value="stop">{tr(locale, "停止", "Stop")}</option></select></label>;
  if (action.type === "color") return <label><span>{tr(locale, "颜色", "Color")}</span><input type="color" value={typeof action.value === "string" ? action.value : "#ff4057"} onChange={(event) => onChange({ ...action, value: event.target.value })} /></label>;
  if (action.type === "opacity") return <CommitInput label={tr(locale, "透明度", "Opacity")} value={String(action.value ?? 0.5)} onCommit={(value) => onChange({ ...action, value: Math.max(0, Math.min(1, Number(value) || 0)) })} />;
  if (action.type === "cameraView") return <label><span>{tr(locale, "镜头", "Camera")}</span><select value={action.cameraViewId ?? ""} onChange={(event) => onChange({ ...action, cameraViewId: event.target.value })}>{(scene?.cameraViews ?? []).map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label>;
  if (action.type === "message") return <CommitInput label={tr(locale, "消息", "Message")} value={action.message ?? ""} onCommit={(message) => onChange({ ...action, message })} />;
  if (action.type === "setData") return <><CommitInput label={tr(locale, "变量", "Variable")} value={action.dataKey ?? ""} onCommit={(dataKey) => onChange({ ...action, dataKey })} /><CommitInput label={tr(locale, "值", "Value")} value={String(action.value ?? "")} onCommit={(value) => onChange({ ...action, value })} /></>;
  if (action.type === "openUrl") return <CommitInput label="URL" value={action.url ?? ""} onCommit={(url) => onChange({ ...action, url })} />;
  if (action.type === "dashboard") return <label><span>{tr(locale, "目标页面", "Target page")}</span><select value={action.dashboardPageId ?? application.pages[0]?.id ?? ""} onChange={(event) => onChange({ ...action, dashboardPageId: event.target.value })}>{application.pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>;
  return null;
}

function CommitInput({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  return <label><span>{label}</span><input defaultValue={value} key={`${label}:${value}`} onBlur={(event) => { const next = event.currentTarget.value.trim(); if (next !== value) onCommit(next); }} /></label>;
}

function defaultAction(locale: AppLocale, type: SceneInteractionActionType, application: ApplicationDocument, sceneId = application.scenes[0]?.id, id: string = crypto.randomUUID()): SceneInteractionActionState {
  const scene = application.scenes.find((candidate) => candidate.id === sceneId);
  const target = [...(scene?.models ?? []), ...(scene?.primitives ?? [])][0];
  const base = { id, type, enabled: true } as const;
  if (OBJECT_ACTIONS.has(type)) return { ...base, ...(sceneId ? { sceneId } : {}), ...(target ? { target: { kind: "object", modelId: target.modelId } as const } : {}), ...(type === "visibility" || type === "animation" ? { value: "toggle" } : {}), ...(type === "color" ? { value: "#ff4057" } : {}), ...(type === "opacity" ? { value: 0.5 } : {}) };
  if (type === "cameraView") return { ...base, ...(sceneId ? { sceneId } : {}), ...(scene?.cameraViews?.[0] ? { cameraViewId: scene.cameraViews[0].id } : {}) };
  if (type === "navigateScene") return { ...base, ...(sceneId ? { sceneId } : {}) };
  if (type === "message") return { ...base, message: tr(locale, "联动已触发", "Interaction triggered") };
  if (type === "setData") return { ...base, dataKey: "selected", value: true };
  if (type === "openUrl") return { ...base, url: "https://example.com", newTab: true };
  if (type === "dashboard") return { ...base, ...(application.pages[0] ? { dashboardPageId: application.pages[0].id } : {}) };
  return base;
}

function triggerLabel(locale: AppLocale, trigger: SceneInteractionTrigger): string {
  const labels: Record<SceneInteractionTrigger, [string, string]> = { click: ["点击", "Click"], doubleClick: ["双击", "Double click"], contextMenu: ["右键", "Context menu"], pointerEnter: ["指针进入", "Pointer enter"], pointerLeave: ["指针离开", "Pointer leave"], load: ["载入", "Load"], animationStart: ["动画开始", "Animation start"], animationEnd: ["动画结束", "Animation end"] };
  return tr(locale, ...labels[trigger]);
}

function actionLabel(locale: AppLocale, type: SceneInteractionActionType): string {
  const labels: Record<SceneInteractionActionType, [string, string]> = { visibility: ["显示/隐藏", "Visibility"], color: ["颜色", "Color"], opacity: ["透明度", "Opacity"], focus: ["聚焦对象", "Focus object"], animation: ["播放动画", "Animation"], openUrl: ["打开网页", "Open URL"], navigateScene: ["切换场景", "Navigate scene"], cameraView: ["切换镜头", "Camera view"], message: ["显示消息", "Message"], dashboard: ["打开二维页面", "Open dashboard page"], setData: ["设置变量", "Set variable"] };
  return tr(locale, ...labels[type]);
}
