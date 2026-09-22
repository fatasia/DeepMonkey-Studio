import type { ApplicationDocument, ApplicationScriptTarget, ScriptModule } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";

/** 检查新旧挂载目标，防止通过改名、改挂载或整批替换绕过对象锁。 */
export function lockedBehaviorScriptChange(
  document: ApplicationDocument,
  next: readonly ScriptModule[],
  engine?: ViewerEngine,
  activeSceneId?: string,
): ScriptModule | undefined {
  const previous = new Map(document.scripts.map(script => [script.id, script]));
  const proposed = new Map(next.map(script => [script.id, script]));
  for (const id of new Set([...previous.keys(), ...proposed.keys()])) {
    const before = previous.get(id), after = proposed.get(id);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before && targetLocked(before.target) || after && targetLocked(after.target)) return after ?? before;
  }
  return undefined;

  function targetLocked(target: ApplicationScriptTarget | undefined): boolean {
    if (!target || target.kind === "scene") return false;
    if (target.kind === "component") {
      return document.pages.some(page => page.nodes.some(node => node.id === target.id && node.locked));
    }
    if (engine) {
      const component = engine.searchComponents?.({}, Infinity).find(item => item.stableId === target.id);
      if (component && engine.isLayerLocked(component.modelId, component.id)) return true;
    }
    return document.scenes.some(scene => [...scene.models, ...scene.primitives].some(object => {
      if (object.modelId !== target.id && !target.id.startsWith(`${object.modelId}:`)) return false;
      if (scene.id === activeSceneId && engine?.listModels().some(model => model.id === object.modelId)) {
        return engine.isModelLocked(object.modelId);
      }
      return object.locked === true;
    }));
  }
}
