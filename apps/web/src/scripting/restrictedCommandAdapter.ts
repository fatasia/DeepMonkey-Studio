import type { SceneInteractionTarget } from "@bim-studio/contracts";
import { parseSceneCommand } from "@bim-studio/scene-sdk";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { SceneCommandExecutor } from "../behavior/SceneCommandExecutor";
import { ViewerSceneCommandPort } from "../behavior/ViewerSceneCommandPort";
import type { BehaviorCommandOut } from "./behaviorGraphRuntime";

export interface RestrictedCommandHost {
  readonly engine: ViewerEngine;
  readonly sceneId: string;
  /** Optional explicit audio port; no implicit browser/global audio access. */
  readonly audio?: (target: string, command: "play" | "pause" | "stop") => void | Promise<void>;
}

/** The adapter is an execution boundary, not an alternate unrestricted script API. */
export async function executeRestrictedCommand(
  host: RestrictedCommandHost,
  command: BehaviorCommandOut,
  interactionTarget: SceneInteractionTarget,
  sequence: number,
): Promise<void> {
  const engine = host.engine;
  const object = (id: string): { kind: "object"; modelId: string } => {
    if (!engine.listModels().some((item) => item.id === id)) throw new Error(`受限动作目标对象 “${id}” 不存在`);
    return { kind: "object", modelId: id };
  };
  switch (command.kind) {
    case "set-value":
    case "trace":
      return;
    case "set-visibility":
      await engine.executeInteractionAction(interactionTarget, {
        id: `restricted.${sequence}`, type: "visibility", enabled: true,
        target: object(command.target), value: command.mode,
      });
      return;
    case "set-color":
      await engine.executeInteractionAction(interactionTarget, {
        id: `restricted.${sequence}`, type: "color", enabled: true,
        target: object(command.target), value: command.color,
      });
      return;
    case "set-opacity":
      if (!Number.isFinite(command.value)) throw new Error("受限透明度必须是有限数值");
      await engine.executeInteractionAction(interactionTarget, {
        id: `restricted.${sequence}`, type: "opacity", enabled: true,
        target: object(command.target), value: Math.max(0, Math.min(1, command.value)),
      });
      return;
    case "animate": {
      if (!command.target) throw new Error("受限动画动作必须显式指定目标对象");
      const target = object(command.target);
      if (command.command === "toggle") {
        await engine.executeInteractionAction(interactionTarget, {
          id: `restricted.${sequence}`, type: "animation", enabled: true, target, value: "toggle",
        });
      } else {
        const outcome = new ViewerSceneCommandPort(engine).controlAnimation(
          { kind: "object", sceneId: host.sceneId, objectId: target.modelId }, { action: command.command },
        );
        if (outcome.status !== "applied") throw new Error(outcome.message);
      }
      return;
    }
    case "audio":
      if (!command.target || !host.audio) throw new Error("受限音频动作缺少显式目标或音频端口");
      await host.audio(command.target, command.command);
      return;
    case "engine-command": {
      // Reuse the SDK's detached structural validator and existing scene-scoped executor.
      const parsed = parseSceneCommand({
        ...command.params, id: `restricted.${sequence}`, type: command.command,
      });
      const [result] = await new SceneCommandExecutor(host.sceneId, new ViewerSceneCommandPort(engine)).execute([parsed]);
      if (!result?.success) throw new Error(result?.message ?? "受限引擎命令没有执行结果");
      return;
    }
  }
}
