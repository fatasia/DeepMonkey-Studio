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
  readonly matchedFlowIds: readonly string[];
  readonly variableUpdates: Readonly<Record<string, JsonValue>>;
  readonly effects: readonly ApplicationInteractionEffect[];
}

export function evaluateApplicationInteraction(
  document: ApplicationDocument,
  event: ApplicationInteractionEvent
): ApplicationInteractionResult {
  const variableUpdates: Record<string, JsonValue> = {};
  const effects: ApplicationInteractionEffect[] = [];
  const matchedFlowIds: string[] = [];

  for (const flow of document.interactions) {
    if (!flow.enabled || flow.trigger !== event.trigger || !sameObjectRef(flow.source, event.source)) continue;
    matchedFlowIds.push(flow.id);
    for (const action of flow.actions) {
      if (!action.enabled) continue;
      if (action.type === "setData" && action.dataKey && action.value !== undefined) {
        variableUpdates[action.dataKey] = structuredClone(action.value);
        continue;
      }
      if (action.type === "dashboard" && action.dataKey) {
        const mapped = mapInteractionValue(action.value, event.payload);
        if (mapped !== undefined) variableUpdates[action.dataKey] = structuredClone(mapped);
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
    matchedFlowIds,
    variableUpdates,
    effects
  };
}

function mapInteractionValue(expression: SceneInteractionActionState["value"], payload: JsonValue | undefined): JsonValue | undefined {
  if (expression === undefined || expression === "$event") return payload;
  if (typeof expression !== "string" || !expression.startsWith("$event.")) return expression;
  let current: JsonValue | undefined = payload;
  for (const segment of expression.slice(7).split(".").filter(Boolean)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (current && typeof current === "object") current = current[segment];
    else return undefined;
  }
  return current;
}

export function sameObjectRef(left: ApplicationObjectRef, right: ApplicationObjectRef): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "object" && right.kind === "object") {
    return left.sceneId === right.sceneId && left.modelId === right.modelId && left.layerId === right.layerId;
  }
  if (left.kind !== "object" && right.kind !== "object") return left.id === right.id;
  return false;
}
