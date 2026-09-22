import type { SpatialItemId } from "../spatial/types.js";
import { AnimationError, type AnimationLayerInput } from "./types.js";

export type AnimationStateId = string;
export type AnimationParameterValue = number | boolean;
export type AnimationParameterMap = Readonly<Record<string, AnimationParameterValue>>;

export interface AnimationState<TNodeId extends SpatialItemId = string> {
  readonly id: AnimationStateId;
  readonly layerId: SpatialItemId;
  readonly clipId: string;
  readonly loop?: boolean;
  readonly speed?: number;
  readonly weight?: number;
  readonly nodeMask?: readonly TNodeId[];
}

export interface AnimationTransition {
  readonly from: AnimationStateId | "*";
  readonly to: AnimationStateId;
  readonly duration: number;
  readonly condition?: AnimationCondition;
}

export type AnimationCondition =
  | { readonly parameter: string; readonly equals: AnimationParameterValue }
  | { readonly parameter: string; readonly greaterThan: number }
  | { readonly parameter: string; readonly lessThan: number }
  | { readonly all: readonly AnimationCondition[] }
  | { readonly any: readonly AnimationCondition[] };

export interface AnimationStateMachineInput<TNodeId extends SpatialItemId = string> {
  readonly states: readonly AnimationState<TNodeId>[];
  readonly transitions: readonly AnimationTransition[];
  readonly initialState: AnimationStateId;
  readonly parameters?: AnimationParameterMap;
}

export interface AnimationStateMachineOptions {
  readonly transitionBudget?: number;
}

/** Small playback boundary implemented by both the Deep mixer and product hosts. */
export interface AnimationStateMachinePlayback<TNodeId extends SpatialItemId = string> {
  play(input: AnimationLayerInput<TNodeId>): void;
  crossFade(fromLayerId: SpatialItemId, to: AnimationLayerInput<TNodeId>, duration: number): void;
}

export interface AnimationStateMachineSnapshot {
  readonly currentState: AnimationStateId;
  readonly parameters: AnimationParameterMap;
  readonly revision: number;
}

/**
 * Deterministic state/transition orchestrator over the existing SceneAnimationMixer.
 * It owns no sampling or graph writes: those remain in the mixer, so state transitions
 * and path constraints share the same frame transaction and rollback semantics.
 */
export class AnimationStateMachine<TNodeId extends SpatialItemId = string> {
  private readonly states = new Map<AnimationStateId, AnimationState<TNodeId>>();
  private readonly transitions: readonly AnimationTransition[];
  private readonly parameters = new Map<string, AnimationParameterValue>();
  private readonly transitionBudget: number;
  private current: AnimationState<TNodeId>;
  private revision = 0;

  constructor(private readonly mixer: AnimationStateMachinePlayback<TNodeId>, input: AnimationStateMachineInput<TNodeId>, options: AnimationStateMachineOptions = {}) {
    if (!input || typeof input !== "object" || !Array.isArray(input.states) || !Array.isArray(input.transitions)) {
      throw new AnimationError("invalid-layer", "Animation state machine input must be an object with states and transitions.");
    }
    this.transitionBudget = validateBudget(options.transitionBudget);
    for (const state of input.states) {
      validateState(state);
      if (this.states.has(state.id)) throw new AnimationError("duplicate-layer", `Animation state already exists: ${state.id}.`);
      this.states.set(state.id, Object.freeze({ ...state }));
    }
    this.transitions = Object.freeze(input.transitions.map((transition) => {
      validateTransition(transition, this.states);
      return Object.freeze({ ...transition, ...(transition.condition ? { condition: freezeCondition(transition.condition) } : {}) });
    }));
    for (const [key, value] of Object.entries(input.parameters ?? {})) this.parameters.set(key, validateParameter(value, key));
    const initial = this.states.get(input.initialState);
    if (!initial) throw new AnimationError("missing-layer", `Initial animation state does not exist: ${input.initialState}.`);
    this.current = initial;
    this.mixer.play(this.layerFor(initial));
  }

  get snapshot(): AnimationStateMachineSnapshot {
    return Object.freeze({ currentState: this.current.id, parameters: Object.freeze(Object.fromEntries(this.parameters)), revision: this.revision });
  }

  setParameter(name: string, value: AnimationParameterValue): void {
    if (typeof name !== "string" || name.length === 0) throw new AnimationError("invalid-layer", "Animation parameter name must be non-empty.");
    this.parameters.set(name, validateParameter(value, name));
    this.revision += 1;
  }

  getParameter(name: string): AnimationParameterValue | undefined { return this.parameters.get(name); }

  /** Selects the first declaration-order transition whose condition is true. */
  transitionTo(target?: AnimationStateId, durationOverride?: number): boolean {
    const transition = target
      ? this.transitions.find((candidate) => candidate.from === this.current.id && candidate.to === target && conditionMatches(candidate.condition, this.parameters))
      : this.transitions.find((candidate) => (candidate.from === this.current.id || candidate.from === "*") && conditionMatches(candidate.condition, this.parameters));
    if (!transition) return false;
    const next = this.states.get(transition.to)!;
    const duration = durationOverride ?? transition.duration;
    validateDuration(duration);
    this.mixer.crossFade(this.current.layerId, this.layerFor(next), duration);
    this.current = next;
    this.revision += 1;
    return true;
  }

  update(deltaSeconds: number): boolean {
    validateDelta(deltaSeconds);
    return this.transitionTo();
  }

  /** Evaluates at most one transition per update, preventing transition storms. */
  drainTransitions(maxTransitions = 1): number {
    if (!Number.isSafeInteger(maxTransitions) || maxTransitions < 0 || maxTransitions > this.transitionBudget) {
      throw new AnimationError("capacity-exceeded", "Animation transition drain budget is invalid.");
    }
    let count = 0;
    while (count < maxTransitions && this.transitionTo()) count += 1;
    return count;
  }

  private layerFor(state: AnimationState<TNodeId>): AnimationLayerInput<TNodeId> {
    const layer: AnimationLayerInput<TNodeId> = { id: state.layerId, clipId: state.clipId, weight: state.weight ?? 1, timeScale: state.speed ?? 1,
      wrapMode: state.loop === false ? "clamp" : "loop", ...(state.nodeMask ? { nodeMask: state.nodeMask } : {}) };
    return layer;
  }
}

function validateState<TNodeId extends SpatialItemId>(state: AnimationState<TNodeId>): void {
  if (!state || typeof state !== "object" || typeof state.id !== "string" || state.id.length === 0
    || (typeof state.layerId !== "string" && typeof state.layerId !== "number") || typeof state.clipId !== "string" || state.clipId.length === 0) {
    throw new AnimationError("invalid-layer", "Animation state id, layerId, and clipId are required.");
  }
  if (state.speed !== undefined && (!Number.isFinite(state.speed) || Math.abs(state.speed) > 1_000_000)) throw new AnimationError("invalid-time", "Animation state speed is invalid.");
  if (state.weight !== undefined && (!Number.isFinite(state.weight) || state.weight < 0 || state.weight > 1)) throw new AnimationError("invalid-layer", "Animation state weight is invalid.");
}
function validateTransition<TNodeId extends SpatialItemId>(transition: AnimationTransition, states: ReadonlyMap<string, AnimationState<TNodeId>>): void {
  if (!transition || typeof transition !== "object" || (transition.from !== "*" && !states.has(transition.from)) || !states.has(transition.to)) {
    throw new AnimationError("invalid-layer", "Animation transition references an unknown state.");
  }
  validateDuration(transition.duration);
  if (transition.condition) validateCondition(transition.condition);
}
function validateCondition(condition: AnimationCondition): void {
  if (!condition || typeof condition !== "object") throw new AnimationError("invalid-layer", "Animation transition condition is invalid.");
  if ("parameter" in condition) {
    if (typeof condition.parameter !== "string" || condition.parameter.length === 0) throw new AnimationError("invalid-layer", "Animation condition parameter is invalid.");
    if (!("equals" in condition || "greaterThan" in condition || "lessThan" in condition)) throw new AnimationError("invalid-layer", "Animation condition operator is missing.");
    return;
  }
  const group = "all" in condition ? condition.all : "any" in condition ? condition.any : undefined;
  if (!Array.isArray(group) || group.length === 0) throw new AnimationError("invalid-layer", "Animation condition group must not be empty.");
  group.forEach(validateCondition);
}
function conditionMatches(condition: AnimationCondition | undefined, parameters: ReadonlyMap<string, AnimationParameterValue>): boolean {
  if (!condition) return true;
  if ("parameter" in condition) {
    const value = parameters.get(condition.parameter);
    if ("equals" in condition) return value === condition.equals;
    if ("greaterThan" in condition) return typeof value === "number" && value > condition.greaterThan;
    return typeof value === "number" && value < condition.lessThan;
  }
  const values = ("all" in condition ? condition.all : condition.any).map((item) => conditionMatches(item, parameters));
  return "all" in condition ? values.every(Boolean) : values.some(Boolean);
}
function freezeCondition(condition: AnimationCondition): AnimationCondition {
  if ("parameter" in condition) return Object.freeze({ ...condition });
  if ("all" in condition) return Object.freeze({ all: Object.freeze(condition.all.map(freezeCondition)) });
  return Object.freeze({ any: Object.freeze(condition.any.map(freezeCondition)) });
}
function validateParameter(value: AnimationParameterValue, name: string): AnimationParameterValue {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new AnimationError("invalid-layer", `Animation parameter ${name} must be a finite number or boolean.`);
}
function validateDuration(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new AnimationError("invalid-time", "Animation transition duration is invalid.");
}
function validateDelta(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new AnimationError("invalid-time", "Animation state update delta is invalid.");
}
function validateBudget(value: number | undefined): number {
  const budget = value ?? 8;
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 256) throw new AnimationError("capacity-exceeded", "Animation transition budget is invalid.");
  return budget;
}
