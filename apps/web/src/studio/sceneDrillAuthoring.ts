import type { SceneInteractionActionState, SceneInteractionScriptState } from "@bim-studio/contracts";
import type { InteractionChoiceOption, InteractionTargetOption } from "../components/InteractionEditor";
import { sameInteractionTarget } from "../interactionState";

export interface DrillDestination { key: string; name: string; action: SceneInteractionActionState; }
export interface DrillSuggestion { key: string; source: InteractionTargetOption; destinationKey: string; reason: "matched" | "ambiguous" | "unmatched"; }

export function drillDestinations(currentSceneId: string, scenes: readonly InteractionChoiceOption[], cameras: readonly InteractionChoiceOption[]): DrillDestination[] {
  return [
    ...scenes.filter((scene) => scene.id !== currentSceneId).map((scene) => ({ key: `scene:${scene.id}`, name: scene.name, action: { id: `scene:${scene.id}`, type: "navigateScene" as const, enabled: true, sceneId: scene.id, newTab: false, transition: { kind: "fade" as const, durationMs: 900, easing: "ease-in-out" as const } } })),
    ...cameras.map((camera) => ({ key: `camera:${camera.id}`, name: camera.name, action: { id: `camera:${camera.id}`, type: "cameraView" as const, enabled: true, cameraViewId: camera.id } })),
    { key: "focus", name: "对象近景", action: { id: "focus", type: "focus", enabled: true } },
  ];
}

export function suggestSceneDrills(sources: readonly InteractionTargetOption[], destinations: readonly DrillDestination[]): DrillSuggestion[] {
  return sources.map((source) => {
    const label = source.target.layerId ? source.label.split("/").at(-1)!.replace(/^[·\s]+/, "") : source.label;
    const name = normalize(label);
    const matches = destinations.filter((destination) => {
      const targetName = normalize(destination.name);
      return destination.key !== "focus" && name.length >= 2 && targetName.length >= 2 && (targetName.includes(name) || name.includes(targetName));
    });
    return { key: `${source.target.modelId}:${source.target.layerId ?? ""}`, source, destinationKey: matches.length === 1 ? matches[0]!.key : "", reason: matches.length === 1 ? "matched" : matches.length ? "ambiguous" : "unmatched" };
  });
}

export function drillConflict(source: InteractionTargetOption, interactions: readonly SceneInteractionScriptState[]): boolean {
  const reservedId = `drill:${encodeURIComponent(`${source.target.modelId}:${source.target.layerId ?? ""}`)}`;
  // 停用的向导事件仍占用身份；界面和生成器都必须保留它，避免可点却永远生成 0 条。
  return interactions.some((item) => item.id === reservedId
    || (item.enabled && item.trigger === "click" && sameInteractionTarget(item.target, source.target)));
}

export function savedDrillDestination(source: InteractionTargetOption, interactions: readonly SceneInteractionScriptState[]): string | undefined {
  const saved = interactions.find((item) => item.id.startsWith("drill:") && item.enabled && item.trigger === "click" && sameInteractionTarget(item.target, source.target));
  const action = saved?.actions?.filter((item) => item.enabled !== false);
  if (action?.length !== 1) return undefined;
  const destination = action[0]!;
  return destination.type === "navigateScene" ? `scene:${destination.sceneId}` : destination.type === "cameraView" ? `camera:${destination.cameraViewId}` : destination.type === "focus" ? "focus" : undefined;
}

export function createSceneDrill(row: DrillSuggestion, destination: DrillDestination): SceneInteractionScriptState {
  const id = `drill:${encodeURIComponent(row.key)}`;
  return { id, name: `${row.source.label} → ${destination.name}`, target: structuredClone(row.source.target), trigger: "click", enabled: true, code: "", actions: [{ ...structuredClone(destination.action), id: `${id}:action`, ...(destination.key === "focus" ? { target: structuredClone(row.source.target) } : {}) }] };
}

export function applySceneDrills(rows: readonly DrillSuggestion[], destinations: readonly DrillDestination[], current: readonly SceneInteractionScriptState[]): { next: SceneInteractionScriptState[]; added: SceneInteractionScriptState[]; skipped: number } {
  const added: SceneInteractionScriptState[] = [];
  let skipped = 0;
  for (const row of rows.filter((item) => item.destinationKey)) {
    const destination = destinations.find((item) => item.key === row.destinationKey);
    if (!destination || drillConflict(row.source, [...current, ...added])) { skipped += 1; continue; }
    const item = createSceneDrill(row, destination);
    added.push(item);
  }
  if (current.length + added.length > 500) throw new Error("场景事件总数不能超过 500，请减少本次生成条目");
  return { next: [...current, ...added], added, skipped };
}

export function undoSceneDrills(current: readonly SceneInteractionScriptState[], added: readonly SceneInteractionScriptState[]): SceneInteractionScriptState[] {
  const unchanged = new Set(added.filter((item) => current.some((existing) => existing.id === item.id && JSON.stringify(existing) === JSON.stringify(item))).map((item) => item.id));
  return current.filter((item) => !unchanged.has(item.id));
}

function normalize(value: string): string { return value.split(/[·|]/)[0]!.replace(/[\s_\-：:（）()]/g, "").toLowerCase(); }
