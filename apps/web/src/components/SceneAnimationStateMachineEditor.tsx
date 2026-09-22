import { AlertTriangle, GitBranch, Play, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import type { SceneAnimationState, SceneAnimationStateMachineState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { createSceneAnimationStateMachine, evaluateSceneAnimationStateConditions, transitionSceneAnimationState } from "../viewer/sceneAnimationStateMachineRuntime";

interface Props {
  engine?: ViewerEngine;
  locale: AppLocale;
  animation: SceneAnimationState;
  onChange: (animation: SceneAnimationState) => void;
}

export function SceneAnimationStateMachineEditor({ engine, locale, animation, onChange }: Props) {
  const [error, setError] = useState<string>();
  const selected = engine?.getSelected();
  const clips = useMemo(() => selected ? engine?.listAnimationClips(selected.id) ?? [] : [], [engine, selected]);
  const machine = animation.stateMachine;
  const selectedMachine = machine?.states.some((state) => state.modelId === selected?.id) ? machine : undefined;

  function createMachine() {
    if (!selected || clips.length === 0) return;
    const next = createSceneAnimationStateMachine(selected.id, clips);
    onChange({ ...animation, stateMachine: next });
    setError(undefined);
  }

  function evaluateConditions() {
    if (!engine || !selectedMachine) return;
    const result = evaluateSceneAnimationStateConditions(engine, selectedMachine);
    if (!result.changed) { setError(result.error); return; }
    setError(undefined);
    onChange({ ...animation, stateMachine: { ...selectedMachine, activeStateId: result.activeStateId } });
  }

  function activate(targetStateId: string) {
    if (!engine || !selectedMachine) return;
    const result = transitionSceneAnimationState(engine, selectedMachine, targetStateId);
    if (!result.changed) { setError(result.error); return; }
    setError(undefined);
    onChange({ ...animation, stateMachine: { ...selectedMachine, activeStateId: result.activeStateId } });
  }

  return <section className="timeline-state-machine" aria-label={tr(locale, "动画状态机", "Animation state machine")}>
    <header><span><GitBranch size={13} /><strong>{tr(locale, "片段状态机", "Clip state machine")}</strong></span>
      {selectedMachine && <label className="timeline-check"><input type="checkbox" checked={selectedMachine.enabled} onChange={(event) => onChange({ ...animation, stateMachine: { ...selectedMachine, enabled: event.target.checked } })} />{tr(locale, "启用", "Enabled")}</label>}
    </header>
    {!selected ? <small>{tr(locale, "选择一个带动画片段的对象。", "Select an object with animation clips.")}</small>
      : clips.length === 0 ? <small>{tr(locale, "所选对象没有可用动画片段。", "The selected object has no animation clips.")}</small>
      : !selectedMachine ? <button type="button" className="timeline-state-create" onClick={createMachine}><GitBranch size={13} />{tr(locale, `从 ${clips.length} 个片段创建`, `Create from ${clips.length} clips`)}</button>
      : <>
        <div className="timeline-state-list">{selectedMachine.states.map((state) => <button type="button" key={state.id} className={state.id === selectedMachine.activeStateId ? "active" : ""} disabled={!selectedMachine.enabled} aria-pressed={state.id === selectedMachine.activeStateId} onClick={() => activate(state.id)}><Play size={11} /><span>{state.name}</span></button>)}</div>
        <label className="timeline-state-duration"><span>{tr(locale, "过渡", "Blend")}</span><input type="number" min="0" max="10" step="0.05" value={selectedMachine.transitionDuration} onChange={(event) => onChange({ ...animation, stateMachine: { ...selectedMachine, transitionDuration: Math.min(10, Math.max(0, Number(event.target.value) || 0)) } })} /><i>s</i></label>
        {(selectedMachine.transitions?.length ?? 0) > 0 && <div className="timeline-state-conditions">
          {Object.entries(selectedMachine.parameters ?? {}).map(([name, value]) => <label className="timeline-check" key={name}><input type="checkbox" checked={value} onChange={(event) => onChange({ ...animation, stateMachine: { ...selectedMachine, parameters: { ...selectedMachine.parameters, [name]: event.target.checked } } })} /><span>{name}</span></label>)}
          <button type="button" disabled={!selectedMachine.enabled} onClick={evaluateConditions}><Workflow size={12} />{tr(locale, "应用条件", "Evaluate")}</button>
          <small>{conditionSummary(locale, selectedMachine)}</small>
        </div>}
      </>}
    {error && <p role="alert"><AlertTriangle size={12} />{error}</p>}
  </section>;
}

function conditionSummary(locale: AppLocale, machine: SceneAnimationStateMachineState): string {
  const transition = machine.transitions?.find((item) => item.fromStateId === machine.activeStateId);
  const target = transition && machine.states.find((state) => state.id === transition.toStateId);
  if (!transition || !target) return tr(locale, "当前状态无条件过渡", "No conditional edge from the active state");
  return `${transition.parameter} = ${String(transition.equals)} → ${target.name}`;
}
