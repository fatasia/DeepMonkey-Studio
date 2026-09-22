import { AnimationStateMachine, type AnimationLayerInput, type AnimationStateMachinePlayback } from "@bim-studio/deep-engine";
import type { SceneAnimationStateMachineState } from "@bim-studio/contracts";
import type { ViewerEngine } from "./ViewerEngine";

export interface SceneAnimationStateTransitionResult {
  readonly changed: boolean;
  readonly activeStateId: string;
  readonly error?: string;
}

export function createSceneAnimationStateMachine(
  modelId: string,
  clips: readonly { readonly id: string; readonly name: string }[],
): SceneAnimationStateMachineState {
  if (!modelId || clips.length === 0) throw new Error("状态机至少需要一个动画片段");
  const states = clips.map((clip) => ({ id: `${modelId}:${clip.id}`, name: clip.name, modelId, clipId: clip.id, loop: true }));
  return {
    enabled: true,
    initialStateId: states[0]!.id,
    activeStateId: states[0]!.id,
    transitionDuration: 0.25,
    states,
    parameters: { advance: false },
    transitions: states.length > 1 ? states.map((state, index) => ({ id: `${state.id}:advance`, fromStateId: state.id,
      toStateId: states[(index + 1) % states.length]!.id, parameter: "advance", equals: true })) : [],
  };
}

/** Executes the persisted clip-state graph through the current product viewer. */
export function transitionSceneAnimationState(
  engine: ViewerEngine,
  configuration: SceneAnimationStateMachineState,
  targetStateId: string,
): SceneAnimationStateTransitionResult {
  const states = configuration.states;
  const active = states.find((state) => state.id === configuration.activeStateId);
  const target = states.find((state) => state.id === targetStateId);
  if (!configuration.enabled) return failure(configuration.activeStateId, "状态机已停用");
  if (!active || !target) return failure(configuration.activeStateId, "状态配置已失效，请重新生成");
  if (active.modelId !== target.modelId) return failure(configuration.activeStateId, "当前切片只支持同一对象内的片段切换");

  const playback = new ViewerClipPlayback(engine, states);
  try {
    const machine = new AnimationStateMachine(playback, {
      states: states.map((state) => ({ id: state.id, layerId: state.id, clipId: state.clipId, loop: state.loop, nodeMask: [state.modelId] })),
      transitions: states.filter((state) => state.id !== active.id).map((state) => ({
        from: active.id,
        to: state.id,
        duration: configuration.transitionDuration,
      })),
      initialState: active.id,
    });
    const changed = target.id === active.id ? true : machine.transitionTo(target.id);
    return changed ? { changed: true, activeStateId: target.id } : failure(active.id, "没有可用的状态过渡");
  } catch (reason) {
    return failure(active.id, reason instanceof Error ? reason.message : String(reason));
  }
}

/** Evaluates one persisted conditional edge, matching the core one-transition-per-update budget. */
export function evaluateSceneAnimationStateConditions(
  engine: ViewerEngine,
  configuration: SceneAnimationStateMachineState,
): SceneAnimationStateTransitionResult {
  const active = configuration.states.find((state) => state.id === configuration.activeStateId);
  if (!configuration.enabled) return failure(configuration.activeStateId, "状态机已停用");
  if (!active) return failure(configuration.activeStateId, "当前状态配置已失效");
  const transitions = (configuration.transitions ?? []).filter((transition) => transition.fromStateId === active.id);
  if (transitions.length === 0) return failure(active.id, "当前状态没有条件过渡");
  const playback = new ViewerClipPlayback(engine, configuration.states);
  try {
    const machine = new AnimationStateMachine(playback, {
      states: configuration.states.map((state) => ({ id: state.id, layerId: state.id, clipId: state.clipId, loop: state.loop, nodeMask: [state.modelId] })),
      transitions: transitions.map((transition) => ({ from: transition.fromStateId, to: transition.toStateId,
        duration: configuration.transitionDuration, condition: { parameter: transition.parameter, equals: transition.equals } })),
      initialState: active.id,
      ...(configuration.parameters ? { parameters: configuration.parameters } : {}),
    });
    const changed = machine.update(0);
    return changed ? { changed: true, activeStateId: machine.snapshot.currentState }
      : failure(active.id, "当前参数未命中过渡条件");
  } catch (reason) {
    return failure(active.id, reason instanceof Error ? reason.message : String(reason));
  }
}

class ViewerClipPlayback implements AnimationStateMachinePlayback<string> {
  private readonly layers = new Map<string, { modelId: string; clipId: string }>();
  constructor(private readonly engine: ViewerEngine, private readonly states: SceneAnimationStateMachineState["states"]) {}

  play(input: AnimationLayerInput<string>): void {
    const state = this.states.find((candidate) => candidate.id === input.id);
    const modelId = state?.modelId ?? input.nodeMask?.[0];
    if (!modelId || !this.engine.controlAnimation(modelId, { action: "play", clipId: input.clipId })) {
      throw new Error(`动画片段不可用：${input.clipId}`);
    }
    this.layers.set(String(input.id), { modelId, clipId: input.clipId });
  }

  crossFade(fromLayerId: string | number, to: AnimationLayerInput<string>, duration: number): void {
    const from = this.layers.get(String(fromLayerId));
    const target = this.states.find((candidate) => candidate.id === to.id);
    const modelId = target?.modelId ?? to.nodeMask?.[0];
    if (!from || !modelId || from.modelId !== modelId
      || !this.engine.transitionAnimationClip(modelId, from.clipId, to.clipId, duration)) {
      throw new Error(`无法切换到动画片段：${to.clipId}`);
    }
    this.layers.set(String(to.id), { modelId, clipId: to.clipId });
  }
}

function failure(activeStateId: string, error: string): SceneAnimationStateTransitionResult {
  return { changed: false, activeStateId, error };
}
