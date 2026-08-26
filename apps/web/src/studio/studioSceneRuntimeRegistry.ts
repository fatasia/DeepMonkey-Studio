import type { ViewerEngine } from "../viewer/ViewerEngine";

const sceneRuntimes = new Map<string, Set<ViewerEngine>>();

export function registerStudioSceneRuntime(sceneId: string, engine: ViewerEngine): () => void {
  const runtimes = sceneRuntimes.get(sceneId) ?? new Set<ViewerEngine>();
  runtimes.add(engine);
  sceneRuntimes.set(sceneId, runtimes);
  return () => {
    runtimes.delete(engine);
    if (runtimes.size === 0) sceneRuntimes.delete(sceneId);
  };
}

/** Returns the live viewport/editor runtime for scripts. A scene may have more than one viewport; the most recently registered runtime wins. */
export function getStudioSceneRuntime(sceneId: string): ViewerEngine | undefined {
  const runtimes = sceneRuntimes.get(sceneId);
  return runtimes ? [...runtimes].at(-1) : undefined;
}
