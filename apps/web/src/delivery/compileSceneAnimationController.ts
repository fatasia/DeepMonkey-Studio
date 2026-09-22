import type { SceneAnimationStateMachineState } from "@bim-studio/contracts";
import {
  validateDynamicSceneRuntime,
  type DynamicSceneRuntime,
} from "@bim-studio/deep-engine/runtime-package";

export interface CompileSceneAnimationControllerInput {
  readonly id: string;
  readonly revision: number;
  readonly stateMachine: SceneAnimationStateMachineState | undefined;
}

/**
 * Compiles the persisted product controller into the versioned dynamic-runtime
 * ABI. Disabled controllers deliberately produce no runtime channel.
 */
export function compileSceneAnimationController(
  input: CompileSceneAnimationControllerInput,
): DynamicSceneRuntime | undefined {
  const controller = input.stateMachine;
  if (!controller?.enabled) return undefined;
  const candidate = {
    schema: "deep-engine.dynamic-runtime",
    schemaVersion: 2,
    id: input.id,
    revision: input.revision,
    animationController: {
      schema: "deep-engine.animation-controller",
      schemaVersion: 1,
      initialStateId: controller.initialStateId,
      activeStateId: controller.activeStateId,
      transitionDurationMs: Math.round(controller.transitionDuration * 1_000),
      states: controller.states.map(({ id, modelId, clipId, loop }) => ({ id, modelId, clipId, loop })),
      parameters: { ...(controller.parameters ?? {}) },
      transitions: (controller.transitions ?? []).map(({ id, fromStateId, toStateId, parameter, equals }) => ({
        id, fromStateId, toStateId, parameter, equals,
      })),
    },
  };
  const parsed = validateDynamicSceneRuntime(candidate);
  if (!parsed.valid) {
    const issue = parsed.issues[0];
    throw new Error(`Animation controller compilation failed at ${issue?.path ?? "$"}: ${issue?.message ?? "invalid runtime"}`);
  }
  return parsed.value;
}
