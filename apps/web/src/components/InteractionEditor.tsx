import { Plus, Play, RotateCcw, Trash2 } from "lucide-react";
import type { SceneInteractionActionState, SceneInteractionActionType, SceneInteractionScriptState, SceneInteractionTarget, SceneInteractionTrigger, SceneVisualTransitionState } from "@bim-studio/contracts";
import { useEffect, useMemo, useState } from "react";
import { translate as tr, type AppLocale } from "../i18n";
import {
  createInteractionAction,
  createInteractionScript,
  defaultInteractionCode,
  INTERACTION_TRIGGERS,
  interactionActionLabel,
  OBJECT_INTERACTION_ACTIONS,
  sameInteractionTarget,
  triggerLabel,
  WIDGET_INTERACTION_ACTIONS,
} from "../interactionState";
import { ProfessionalCodeEditor } from "./ProfessionalCodeEditor";
import type { SceneScriptIntelligenceContext } from "../studio/sceneScriptContext";

export interface InteractionTargetOption {
  label: string;
  target: { kind: "object"; modelId: string; layerId?: string };
}

export interface InteractionChoiceOption {
  id: string;
  name: string;
}

export function InteractionEditor({
  locale,
  target,
  targetName,
  interactions,
  targetOptions = [],
  sceneOptions = [],
  pageOptions = [],
  cameraViewOptions = [],
  intelligence,
  disabled = false,
  onChange,
  onTest,
  onOpenDocs,
}: {
  locale: AppLocale;
  target: SceneInteractionTarget;
  targetName: string;
  interactions: SceneInteractionScriptState[];
  targetOptions?: InteractionTargetOption[];
  sceneOptions?: InteractionChoiceOption[];
  pageOptions?: InteractionChoiceOption[];
  cameraViewOptions?: InteractionChoiceOption[];
  intelligence?: SceneScriptIntelligenceContext;
  disabled?: boolean;
  onChange: (interactions: SceneInteractionScriptState[]) => void;
  onTest: (script: SceneInteractionScriptState) => void;
  onOpenDocs?: () => void;
}) {
  const targetScripts = useMemo(() => interactions.filter((script) => sameInteractionTarget(script.target, target)), [interactions, target]);
  const [selectedTrigger, setSelectedTrigger] = useState<SceneInteractionTrigger>(targetScripts[0]?.trigger ?? "click");
  const actionTypes = target.kind === "widget" ? WIDGET_INTERACTION_ACTIONS : OBJECT_INTERACTION_ACTIONS;
  const [newActionType, setNewActionType] = useState<SceneInteractionActionType>(actionTypes[0]!);
  const selected = targetScripts.find((script) => script.trigger === selectedTrigger);

  useEffect(() => {
    if (targetScripts.length > 0 && !targetScripts.some((script) => script.trigger === selectedTrigger)) setSelectedTrigger(targetScripts[0]!.trigger);
  }, [selectedTrigger, targetScripts]);

  function selectTrigger(trigger: SceneInteractionTrigger) {
    setSelectedTrigger(trigger);
    if (targetScripts.some((script) => script.trigger === trigger)) return;
    if (disabled) return;
    onChange([...interactions, createInteractionScript(target, trigger)]);
  }

  function updateSelected(patch: Partial<SceneInteractionScriptState>) {
    if (!selected || disabled) return;
    onChange(interactions.map((script) => (script.id === selected.id ? { ...script, ...patch } : script)));
  }

  function removeSelected() {
    if (!selected || disabled) return;
    onChange(interactions.filter((script) => script.id !== selected.id));
  }

  function addAction() {
    if (!selected) return;
    const action = createInteractionAction(newActionType);
    if (newActionType === "dashboard" && pageOptions[0]) action.dashboardPageId = pageOptions[0].id;
    updateSelected({ actions: [...(selected.actions ?? []), action] });
  }

  function updateAction(id: string, patch: Partial<SceneInteractionActionState>) {
    if (!selected) return;
    updateSelected({ actions: (selected.actions ?? []).map((action) => (action.id === id ? { ...action, ...patch } : action)) });
  }

  function removeAction(id: string) {
    if (!selected) return;
    updateSelected({ actions: (selected.actions ?? []).filter((action) => action.id !== id) });
  }

  return (
    <details className="interaction-editor">
      <summary>
        <span>{tr(locale, "事件", "Events")}</span>
        <small>{targetScripts.filter((script) => script.enabled).length}</small>
      </summary>
      <div className="interaction-editor-body">
        <div className="interaction-editor-heading">
          <div>
            <strong>{targetName}</strong>
            <small>
              {target.kind === "widget"
                ? tr(locale, "二维看板组件", "Dashboard widget")
                : target.layerId
                  ? tr(locale, "图层 / 构件", "Layer / component")
                  : tr(locale, "整个模型", "Whole model")}
            </small>
          </div>
          <em>{tr(locale, "可信脚本 · 完整对象访问", "Trusted scripts · full object access")}</em>
        </div>
        <div className="interaction-trigger-grid">
          {INTERACTION_TRIGGERS.map((trigger) => {
            const script = targetScripts.find((item) => item.trigger === trigger);
            return (
              <button key={trigger} disabled={disabled && !script} className={`${selectedTrigger === trigger ? "selected" : ""} ${script?.enabled ? "enabled" : ""}`} onClick={() => selectTrigger(trigger)}>
                <i />
                {triggerLabel(trigger, locale)}
              </button>
            );
          })}
        </div>
        {selected && (
          <fieldset className="interaction-code-editor" disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <header>
              <label>
                <input type="checkbox" checked={selected.enabled} onChange={(event) => updateSelected({ enabled: event.target.checked })} />
                {tr(locale, "启用", "Enabled")}
              </label>
              <input
                className="interaction-event-name"
                aria-label={tr(locale, "事件名称", "Event name")}
                value={selected.name}
                onChange={(event) => updateSelected({ name: event.target.value || tr(locale, "默认事件", "Default event") })}
              />
              <span>{triggerLabel(selected.trigger, locale)}</span>
            </header>
            <section className="interaction-actions">
              <div className="interaction-action-add">
                <select value={newActionType} onChange={(event) => setNewActionType(event.target.value as SceneInteractionActionType)}>
                  {actionTypes.map((type) => (
                    <option key={type} value={type}>
                      {interactionActionLabel(type, locale)}
                    </option>
                  ))}
                </select>
                <button onClick={addAction}>
                  <Plus size={12} />
                  {tr(locale, "添加动作", "Add action")}
                </button>
              </div>
              {(selected.actions ?? []).length === 0 && <p>{tr(locale, "还没有动作。选择上方动作后点击添加。", "No actions yet. Select an action above and add it.")}</p>}
              {(selected.actions ?? []).map((action) => (
                <InteractionActionRow
                  key={action.id}
                  locale={locale}
                  action={action}
                  targetOptions={targetOptions}
                  sceneOptions={sceneOptions}
                  pageOptions={pageOptions}
                  cameraViewOptions={cameraViewOptions}
                  onChange={(patch) => updateAction(action.id, patch)}
                  onDelete={() => removeAction(action.id)}
                />
              ))}
            </section>
            <details className="interaction-advanced">
              <summary>{tr(locale, "高级 JavaScript", "Advanced JavaScript")}</summary>
              {disabled ? <pre tabIndex={0} aria-label={tr(locale, "只读事件脚本", "Read-only event script")} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{selected.code}</pre> : <ProfessionalCodeEditor
                compact
                locale={locale}
                path={`bim-studio://interaction/${selected.id}.js`}
                height={220}
                value={selected.code}
                {...(intelligence ? { intelligence } : {})}
                onChange={(code) => updateSelected({ code })}
                onRun={() => onTest(selected)}
                {...(onOpenDocs ? { onOpenDocs } : {})}
              />}
              <small>
                {tr(
                  locale,
                  "对象、组件、数据键和场景引用均来自当前项目；Ctrl+Space 查看提示，悬停查看类型与关联文档，Ctrl+Enter 测试事件。",
                  "Object, component, data and scene references come from this project; use Ctrl+Space for suggestions, hover for types and linked docs, and Ctrl+Enter to test.",
                )}
              </small>
            </details>
            <footer>
              <span>{tr(locale, `已配置 ${(selected.actions ?? []).length} 个内置动作`, `${(selected.actions ?? []).length} built-in actions`)}</span>
              <div>
                <button
                  title={tr(locale, "恢复默认注释", "Restore default comments")}
                  onClick={() => updateSelected({ code: defaultInteractionCode(selected.trigger, target.kind) })}
                >
                  <RotateCcw size={12} />
                </button>
                <button title={tr(locale, "测试事件", "Test event")} onClick={() => onTest(selected)}>
                  <Play size={12} />
                  {tr(locale, "测试", "Test")}
                </button>
                <button className="danger" title={tr(locale, "删除事件", "Delete event")} onClick={removeSelected}>
                  <Trash2 size={12} />
                </button>
              </div>
            </footer>
          </fieldset>
        )}
      </div>
    </details>
  );
}

function InteractionActionRow({
  locale,
  action,
  targetOptions,
  sceneOptions,
  pageOptions,
  cameraViewOptions,
  onChange,
  onDelete,
}: {
  locale: AppLocale;
  action: SceneInteractionActionState;
  targetOptions: InteractionTargetOption[];
  sceneOptions: InteractionChoiceOption[];
  pageOptions: InteractionChoiceOption[];
  cameraViewOptions: InteractionChoiceOption[];
  onChange: (patch: Partial<SceneInteractionActionState>) => void;
  onDelete: () => void;
}) {
  const needsObject = ["visibility", "color", "opacity", "focus", "animation"].includes(action.type);
  const targetValue = action.target ? `${action.target.modelId}::${action.target.layerId ?? ""}` : "";
  return (
    <article className="interaction-action-row">
      <label className="interaction-action-title">
        <input type="checkbox" checked={action.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
        <span>{interactionActionLabel(action.type, locale)}</span>
      </label>
      <button className="danger" title={tr(locale, "删除动作", "Delete action")} onClick={onDelete}>
        <Trash2 size={12} />
      </button>
      {needsObject && (
        <select
          className="interaction-action-target"
          value={targetValue}
          onChange={(event) => {
            const option = targetOptions.find((item) => `${item.target.modelId}::${item.target.layerId ?? ""}` === event.target.value);
            onChange(option ? { target: option.target } : { target: undefined });
          }}
        >
          <option value="">{tr(locale, "触发对象", "Trigger object")}</option>
          {targetOptions.map((option) => (
            <option key={`${option.target.modelId}:${option.target.layerId ?? "root"}`} value={`${option.target.modelId}::${option.target.layerId ?? ""}`}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      <div className="interaction-action-value">
        <InteractionActionValue locale={locale} action={action} sceneOptions={sceneOptions} pageOptions={pageOptions} cameraViewOptions={cameraViewOptions} onChange={onChange} />
      </div>
    </article>
  );
}

function InteractionActionValue({
  locale,
  action,
  sceneOptions,
  pageOptions,
  cameraViewOptions,
  onChange,
}: {
  locale: AppLocale;
  action: SceneInteractionActionState;
  sceneOptions: InteractionChoiceOption[];
  pageOptions: InteractionChoiceOption[];
  cameraViewOptions: InteractionChoiceOption[];
  onChange: (patch: Partial<SceneInteractionActionState>) => void;
}) {
  if (action.type === "visibility")
    return (
      <div className="interaction-action-transition">
        <select value={String(action.value ?? "toggle")} onChange={(event) => onChange({ value: event.target.value })}>
          <option value="toggle">{tr(locale, "切换", "Toggle")}</option>
          <option value="show">{tr(locale, "显示", "Show")}</option>
          <option value="hide">{tr(locale, "隐藏", "Hide")}</option>
        </select>
        <TransitionControls locale={locale} value={action.transition} onChange={(transition) => onChange({ transition })} />
      </div>
    );
  if (action.type === "animation")
    return (
      <select value={String(action.value ?? "toggle")} onChange={(event) => onChange({ value: event.target.value })}>
        <option value="toggle">{tr(locale, "播放 / 停止", "Play / stop")}</option>
        <option value="play">{tr(locale, "播放", "Play")}</option>
        <option value="stop">{tr(locale, "停止", "Stop")}</option>
      </select>
    );
  if (action.type === "prefabAction")
    return (
      <select value={action.prefabAction ?? "dispatch"} onChange={(event) => onChange({ prefabAction: event.target.value as NonNullable<typeof action.prefabAction> })}>
        <option value="dispatch">{tr(locale, "派发并运行", "Dispatch")}</option>
        <option value="pause">{tr(locale, "暂停", "Pause")}</option>
        <option value="resume">{tr(locale, "继续", "Resume")}</option>
        <option value="stop">{tr(locale, "停止", "Stop")}</option>
        <option value="return">{tr(locale, "返回起点", "Return")}</option>
        <option value="replay">{tr(locale, "从头重播", "Replay")}</option>
        <option value="clear-fault">{tr(locale, "清除故障", "Clear fault")}</option>
      </select>
    );
  if (action.type === "color")
    return (
      <label className="interaction-action-color">
        <input type="color" value={String(action.value ?? "#ff4057")} onChange={(event) => onChange({ value: event.target.value })} />
        <code>{String(action.value ?? "#ff4057").toUpperCase()}</code>
      </label>
    );
  if (action.type === "opacity")
    return (
      <label className="interaction-action-range">
        <input type="range" min="0" max="1" step="0.05" value={Number(action.value ?? 0.5)} onChange={(event) => onChange({ value: Number(event.target.value) })} />
        <output>{Math.round(Number(action.value ?? 0.5) * 100)}%</output>
      </label>
    );
  if (action.type === "openUrl")
    return (
      <div className="interaction-action-url">
        <input value={action.url ?? ""} placeholder="https://example.com" onChange={(event) => onChange({ url: event.target.value })} />
        <label>
          <input type="checkbox" checked={action.newTab !== false} onChange={(event) => onChange({ newTab: event.target.checked })} />
          {tr(locale, "新窗口", "New tab")}
        </label>
      </div>
    );
  if (action.type === "navigateScene")
    return (
      <div className="interaction-action-scene">
        <select value={action.sceneId ?? ""} onChange={(event) => onChange({ sceneId: event.target.value })}>
          <option value="">{tr(locale, "选择场景", "Choose scene")}</option>
          {sceneOptions.map((scene) => (
            <option key={scene.id} value={scene.id}>
              {scene.name}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={action.newTab === true} onChange={(event) => onChange({ newTab: event.target.checked })} />
          {tr(locale, "新窗口", "New tab")}
        </label>
        {!action.newTab && <TransitionControls locale={locale} value={action.transition} onChange={(transition) => onChange({ transition })} />}
      </div>
    );
  if (action.type === "cameraView")
    return (
      <select value={action.cameraViewId ?? ""} onChange={(event) => onChange({ cameraViewId: event.target.value })}>
        <option value="">{tr(locale, "选择相机视角", "Choose camera view")}</option>
        {cameraViewOptions.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
          </option>
        ))}
      </select>
    );
  if (action.type === "message")
    return <input value={action.message ?? ""} placeholder={tr(locale, "输入提示文字", "Message text")} onChange={(event) => onChange({ message: event.target.value })} />;
  if (action.type === "dashboard")
    return (
      <select value={action.dashboardPageId ?? ""} onChange={(event) => onChange({ dashboardPageId: event.target.value })}>
        <option value="">{tr(locale, "选择二维页面", "Choose 2D page")}</option>
        {pageOptions.map((page) => (
          <option key={page.id} value={page.id}>
            {page.name}
          </option>
        ))}
      </select>
    );
  if (action.type === "setData")
    return (
      <div className="interaction-action-data">
        <input value={action.dataKey ?? "value"} placeholder={tr(locale, "数据键", "Data key")} onChange={(event) => onChange({ dataKey: event.target.value })} />
        <input value={String(action.value ?? "")} placeholder={tr(locale, "值", "Value")} onChange={(event) => onChange({ value: parseActionValue(event.target.value) })} />
      </div>
    );
  if (action.type === "unityAction")
    return (
      <div className="interaction-action-data">
        <input value={action.unityAction ?? ""} placeholder={tr(locale, "Unity 动作名", "Unity action name")} onChange={(event) => onChange({ unityAction: event.target.value })} />
        <input
          value={action.unityObjectId ?? ""}
          placeholder={tr(locale, "Unity 对象 ID（可选）", "Unity object ID (optional)")}
          onChange={(event) => onChange({ unityObjectId: event.target.value })}
        />
      </div>
    );
  return <span>{tr(locale, "无需参数", "No parameters")}</span>;
}

function TransitionControls({ locale, value, onChange }: {
  locale: AppLocale;
  value: SceneVisualTransitionState | undefined;
  onChange: (value: SceneVisualTransitionState) => void;
}) {
  const transition = value ?? { kind: "none", durationMs: 0, easing: "ease-out" };
  return (
    <div className="interaction-transition-controls">
      <select
        aria-label={tr(locale, "过渡效果", "Transition")}
        value={transition.kind}
        onChange={(event) => {
          const kind = event.target.value as SceneVisualTransitionState["kind"];
          onChange({ ...transition, kind, durationMs: kind === "none" ? 0 : Math.max(transition.durationMs, 280) });
        }}
      >
        <option value="none">{tr(locale, "即时", "Instant")}</option>
        <option value="fade">{tr(locale, "淡入淡出", "Fade")}</option>
        <option value="scale">{tr(locale, "缩放", "Scale")}</option>
        <option value="rise">{tr(locale, "升起", "Rise")}</option>
      </select>
      {transition.kind !== "none" && (
        <label>
          <input
            aria-label={tr(locale, "过渡时长", "Duration")}
            type="number"
            min="80"
            max="5000"
            step="20"
            value={transition.durationMs}
            onChange={(event) => onChange({ ...transition, durationMs: Number(event.target.value) })}
          />
          <small>ms</small>
        </label>
      )}
    </div>
  );
}

function parseActionValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value);
  return value.trim() && Number.isFinite(number) ? number : value;
}
