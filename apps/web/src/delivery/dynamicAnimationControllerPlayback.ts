import {
  validateDynamicSceneRuntime,
  type DeepRuntimePackage,
  type DynamicAnimationControllerRuntime,
  type DynamicAnimationControllerState,
  type DynamicAnimationControllerTransition,
} from "@bim-studio/deep-engine/runtime-package";

export interface DynamicAnimationControllerSink {
  playClip(modelId: string, clipId: string, loop: boolean): boolean;
  transitionClip(input: {
    readonly modelId: string;
    readonly fromClipId: string;
    readonly toClipId: string;
    readonly durationMs: number;
    readonly loop: boolean;
  }): boolean;
}

export interface DynamicAnimationControllerStep {
  readonly applied: boolean;
  readonly transition?: DynamicAnimationControllerTransition;
  readonly activeStateId: string;
}

function controllerFromPackage(runtimePackage: DeepRuntimePackage): DynamicAnimationControllerRuntime {
  const id = runtimePackage.entrypoints.dynamicRuntime;
  if (!id) throw new Error("Runtime package has no dynamicRuntime entrypoint.");
  const parsed = validateDynamicSceneRuntime(runtimePackage.payloads[id]);
  if (!parsed.valid) throw new Error(`Invalid dynamicRuntime payload: ${parsed.issues[0]?.message ?? "unknown error"}`);
  if (!parsed.value.animationController) throw new Error("Dynamic runtime has no animation controller.");
  return parsed.value.animationController;
}

/** Stateful product-player consumer for the dynamic-runtime v2 clip controller. */
export class DynamicAnimationControllerPlayer {
  readonly #sink: DynamicAnimationControllerSink;
  readonly #states: ReadonlyMap<string, DynamicAnimationControllerState>;
  readonly #transitions: readonly DynamicAnimationControllerTransition[];
  readonly #durationMs: number;
  readonly #parameters: Record<string, boolean>;
  #activeStateId: string;

  constructor(runtimePackage: DeepRuntimePackage, sink: DynamicAnimationControllerSink) {
    const controller = controllerFromPackage(runtimePackage);
    this.#sink = sink;
    this.#states = new Map(controller.states.map(state => [state.id, state]));
    this.#transitions = controller.transitions;
    this.#durationMs = controller.transitionDurationMs;
    this.#parameters = { ...controller.parameters };
    this.#activeStateId = controller.activeStateId;
  }

  get activeStateId(): string { return this.#activeStateId; }

  /** Starts the package-authored active clip. A rejected host command changes no player state. */
  start(): boolean {
    const state = this.#states.get(this.#activeStateId);
    return state ? this.#sink.playClip(state.modelId, state.clipId, state.loop) : false;
  }

  setParameter(name: string, value: boolean): boolean {
    if (!Object.hasOwn(this.#parameters, name)) return false;
    this.#parameters[name] = value;
    return true;
  }

  /** Evaluates at most one authored edge, in declaration order. */
  evaluate(): DynamicAnimationControllerStep {
    const transition = this.#transitions.find(candidate => (
      candidate.fromStateId === this.#activeStateId
      && this.#parameters[candidate.parameter] === candidate.equals
    ));
    if (!transition) return { applied: false, activeStateId: this.#activeStateId };
    const from = this.#states.get(transition.fromStateId);
    const to = this.#states.get(transition.toStateId);
    if (!from || !to || from.modelId !== to.modelId) {
      return { applied: false, transition, activeStateId: this.#activeStateId };
    }
    const applied = this.#sink.transitionClip({
      modelId: to.modelId,
      fromClipId: from.clipId,
      toClipId: to.clipId,
      durationMs: this.#durationMs,
      loop: to.loop,
    });
    if (applied) this.#activeStateId = to.id;
    return { applied, transition, activeStateId: this.#activeStateId };
  }
}
