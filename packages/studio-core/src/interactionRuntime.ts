import type {
  ApplicationDocument,
  ApplicationObjectRef,
  JsonValue,
  SceneInteractionActionState,
  SceneInteractionTrigger
} from "@bim-studio/contracts";

export interface ApplicationInteractionEvent {
  readonly source: ApplicationObjectRef;
  readonly trigger: SceneInteractionTrigger;
  readonly timestamp: string;
  readonly payload?: JsonValue;
  readonly selectSource?: boolean;
}

export interface ApplicationInteractionEffect {
  readonly flowId: string;
  readonly source: ApplicationObjectRef;
  readonly action: SceneInteractionActionState;
  readonly timestamp: string;
}

export interface ApplicationInteractionResult {
  readonly selection?: readonly ApplicationObjectRef[];
  readonly variableUpdates: Readonly<Record<string, JsonValue>>;
  readonly effects: readonly ApplicationInteractionEffect[];
}

export function evaluateApplicationInteraction(
  document: ApplicationDocument,
  event: ApplicationInteractionEvent
): ApplicationInteractionResult {
  const variableUpdates: Record<string, JsonValue> = {};
  const effects: ApplicationInteractionEffect[] = [];

  for (const flow of document.interactions) {
    if (!flow.enabled || flow.trigger !== event.trigger || !sameObjectRef(flow.source, event.source)) continue;
    for (const action of flow.actions) {
      if (!action.enabled) continue;
      if (action.type === "setData" && action.dataKey && action.value !== undefined) {
        variableUpdates[action.dataKey] = structuredClone(action.value);
        continue;
      }
      effects.push({
        flowId: flow.id,
        source: structuredClone(event.source),
        action: structuredClone(action),
        timestamp: event.timestamp
      });
    }
  }

  return {
    ...(event.trigger === "click" && event.selectSource !== false ? { selection: [structuredClone(event.source)] } : {}),
    variableUpdates,
    effects
  };
}

export function sameObjectRef(left: ApplicationObjectRef, right: ApplicationObjectRef): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "object" && right.kind === "object") {
    return left.sceneId === right.sceneId && left.modelId === right.modelId && left.layerId === right.layerId;
  }
  if (left.kind !== "object" && right.kind !== "object") return left.id === right.id;
  return false;
}
