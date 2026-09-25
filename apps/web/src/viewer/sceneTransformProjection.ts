import type { ModelTransform, SceneSnapshot } from "@bim-studio/contracts";
import { SceneTransformGraph } from "@bim-studio/deep-engine/scene";
import { modelTransformToSceneLocalTrs } from "../commands/engineTransformGraph";

/** Validates author snapshot transforms through the same Deep graph contract used by edit commands. */
export function validateSceneSnapshotTransforms(scene: Pick<SceneSnapshot, "models">): void {
  const graph = new SceneTransformGraph();
  for (const model of scene.models) {
    const transform = model.transform as ModelTransform;
    graph.create({ id: `model:${model.modelId}`, localTransform: modelTransformToSceneLocalTrs(transform) });
  }
  graph.flush();
}
