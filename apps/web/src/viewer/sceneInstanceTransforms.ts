import { Matrix4 } from "three";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { sceneModelMatrixValues } from "../delivery/sceneModelMatrixValues";
import { localizeSceneCoordinates } from "../delivery/sceneLocalCoordinates";
import { studioAuthorRenderPacketKey } from "./studioAuthorRenderPacketKey";

const IDENTITY = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
export function sceneTransformIndependentKey(scene: SceneSnapshot, models: ProjectRecord["models"]): string {
  return studioAuthorRenderPacketKey({ ...scene, models: scene.models.map(model => ({ ...model, transform: IDENTITY })) }, models)
    + ":" + runtimeContentSha256(models.map(model => ({ id: model.id, status: model.status, manifest: model.manifest ?? null })));
}

/** Always derive from the original compiled baseline; repeated edits cannot accumulate matrix error. */
export function transformSceneInstances<T extends { readonly id: string; readonly transform: ArrayLike<number> }>(
  original: SceneSnapshot, changed: SceneSnapshot, bindings: readonly { readonly nodeId: string; readonly instanceIds: readonly string[] }[],
  instances: readonly T[], origin?: { readonly x: number; readonly y: number; readonly z: number },
): Array<Omit<T, "transform"> & { transform: ArrayLike<number> }> | undefined {
  const before = origin ? localizeSceneCoordinates(original, origin).scene : original;
  const after = origin ? localizeSceneCoordinates(changed, origin).scene : changed;
  if (before.models.length !== after.models.length) return undefined;
  const byId = new Map(instances.map(instance => [instance.id, instance]));
  const byNode = new Map(bindings.map(binding => [binding.nodeId, binding.instanceIds]));
  const updates = new Map<string, number[]>();
  for (let index = 0; index < before.models.length; index++) {
    const previous = before.models[index]!, next = after.models[index]!;
    if (previous.modelId !== next.modelId) return undefined;
    if (JSON.stringify(previous.transform) === JSON.stringify(next.transform)) continue;
    const ids = byNode.get(previous.modelId);
    if (!ids) return undefined;
    const old = new Matrix4().fromArray(sceneModelMatrixValues(previous.transform, previous.modelId));
    if (!Number.isFinite(old.determinant()) || Math.abs(old.determinant()) < 1e-12) return undefined;
    const delta = new Matrix4().fromArray(sceneModelMatrixValues(next.transform, next.modelId)).multiply(old.invert());
    for (const id of ids) {
      const instance = byId.get(id);
      if (!instance || updates.has(id)) return undefined;
      const transform = new Matrix4().multiplyMatrices(delta, new Matrix4().fromArray(instance.transform)).elements.map(Math.fround);
      if (transform.some(value => !Number.isFinite(value))) return undefined;
      updates.set(id, transform);
    }
  }
  return instances.map(instance => ({ ...instance, transform: updates.get(instance.id) ?? instance.transform }));
}
