import type { SceneCommand, SceneObjectRef } from "@bim-studio/scene-sdk";

type CommandOf<TType extends SceneCommand["type"]> = Extract<SceneCommand, { type: TType }>;
type MaybePromise<T> = T | Promise<T>;

export type SceneCommandPortOutcome =
  | { status: "applied" }
  | { status: "unsupported"; message: string };

export interface SceneCommandPort {
  setObjectVisibility(target: SceneObjectRef, visible: boolean): MaybePromise<SceneCommandPortOutcome>;
  setObjectTransform(
    target: SceneObjectRef,
    transform: Pick<CommandOf<"object.set-transform">, "position" | "rotation" | "scale">
  ): MaybePromise<SceneCommandPortOutcome>;
  setSelection(targets: readonly SceneObjectRef[]): MaybePromise<SceneCommandPortOutcome>;
  setCamera(
    sceneId: string,
    camera: Pick<CommandOf<"camera.set">, "position" | "target" | "near" | "far" | "fov">
  ): MaybePromise<SceneCommandPortOutcome>;
  flyCamera(
    sceneId: string,
    target: CommandOf<"camera.fly-to">["target"],
    durationMs: number
  ): MaybePromise<SceneCommandPortOutcome>;
  controlAnimation(
    target: SceneObjectRef,
    control: Pick<CommandOf<"animation.control">, "action" | "clipId" | "time">
  ): MaybePromise<SceneCommandPortOutcome>;
  applyData(
    target: SceneObjectRef,
    data: Pick<CommandOf<"data.apply">, "values" | "timestamp">
  ): MaybePromise<SceneCommandPortOutcome>;
  updateComponent(componentId: string, patch: Record<string, import("@bim-studio/contracts").JsonValue>): MaybePromise<SceneCommandPortOutcome>;
}

export type SceneCommandExecutionErrorCode = "scene-mismatch" | "unsupported" | "port-error";

export type SceneCommandExecutionResult =
  | { index: number; id: string; type: SceneCommand["type"]; success: true }
  | {
      index: number;
      id: string;
      type: SceneCommand["type"];
      success: false;
      code: SceneCommandExecutionErrorCode;
      message: string;
    };

export const SCENE_COMMAND_APPLIED: SceneCommandPortOutcome = Object.freeze({ status: "applied" });

/**
 * Sequentially maps validated Scene SDK commands to a renderer-independent port.
 * A rejected command never prevents later commands in the same batch from running.
 */
export class SceneCommandExecutor {
  constructor(
    private readonly sceneId: string,
    private readonly port: SceneCommandPort
  ) {
    if (sceneId.trim().length === 0) throw new TypeError("当前场景 ID 不能为空。");
  }

  async execute(commands: readonly SceneCommand[]): Promise<SceneCommandExecutionResult[]> {
    const results: SceneCommandExecutionResult[] = [];
    for (let index = 0; index < commands.length; index += 1) {
      results.push(await this.executeOne(commands[index]!, index));
    }
    return results;
  }

  private async executeOne(command: SceneCommand, index: number): Promise<SceneCommandExecutionResult> {
    const scopeError = sceneScopeError(command, this.sceneId);
    if (scopeError) return failure(command, index, "scene-mismatch", scopeError);

    try {
      const outcome = await dispatchCommand(this.port, command);
      if (outcome.status === "unsupported") {
        return failure(command, index, "unsupported", outcome.message || `当前场景不支持 ${command.type} 命令。`);
      }
      return { index, id: command.id, type: command.type, success: true };
    } catch (error) {
      return failure(command, index, "port-error", readableError(error, command.type));
    }
  }
}

async function dispatchCommand(port: SceneCommandPort, command: SceneCommand): Promise<SceneCommandPortOutcome> {
  switch (command.type) {
    case "object.set-visibility":
      return port.setObjectVisibility(command.target, command.visible);
    case "object.set-transform":
      return port.setObjectTransform(command.target, optionalFields(command, ["position", "rotation", "scale"]));
    case "selection.set":
      return port.setSelection(command.targets);
    case "camera.set":
      return port.setCamera(command.sceneId, optionalFields(command, ["position", "target", "near", "far", "fov"]));
    case "camera.fly-to":
      return port.flyCamera(command.sceneId, command.target, command.durationMs);
    case "animation.control":
      return port.controlAnimation(command.target, optionalFields(command, ["action", "clipId", "time"]));
    case "data.apply":
      return port.applyData(command.target, { values: command.values, timestamp: command.timestamp });
    case "component.update":
      return port.updateComponent(command.componentId, command.patch);
  }
}

function sceneScopeError(command: SceneCommand, activeSceneId: string): string | undefined {
  if (command.type === "camera.set" || command.type === "camera.fly-to") {
    if (command.sceneId !== activeSceneId) return mismatchMessage(command.sceneId, activeSceneId);
  }

  const targets = commandTargets(command);
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    if (target.sceneId !== activeSceneId) {
      const location = targets.length > 1 ? `目标 ${index + 1}` : "目标";
      return `${location}的${mismatchMessage(target.sceneId, activeSceneId)}`;
    }
  }
  return undefined;
}

function commandTargets(command: SceneCommand): readonly SceneObjectRef[] {
  switch (command.type) {
    case "selection.set":
      return command.targets;
    case "object.set-visibility":
    case "object.set-transform":
    case "animation.control":
    case "data.apply":
      return [command.target];
    case "camera.fly-to":
      return "kind" in command.target ? [command.target] : [];
    case "camera.set":
    case "component.update":
      return [];
  }
}

function mismatchMessage(targetSceneId: string, activeSceneId: string): string {
  return `场景 ID “${targetSceneId}” 与当前场景 “${activeSceneId}” 不一致。`;
}

function failure(
  command: SceneCommand,
  index: number,
  code: SceneCommandExecutionErrorCode,
  message: string
): SceneCommandExecutionResult {
  return { index, id: command.id, type: command.type, success: false, code, message };
}

function readableError(error: unknown, commandType: SceneCommand["type"]): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return `执行 ${commandType} 命令时发生未知错误。`;
}

function optionalFields<TObject extends object, TKey extends keyof TObject>(
  source: TObject,
  keys: readonly TKey[]
): Pick<TObject, TKey> {
  const result = {} as Pick<TObject, TKey>;
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}
