import { canonicalJson, fingerprint64Labeled, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";

let last: { canonical: string; key: string } | undefined;

/** Capture time, camera and editor selection do not change the compiled geometry/material packet. */
export function studioAuthorRenderPacketKey(scene: SceneSnapshot, models: ProjectRecord["models"]): string {
  const { updatedAt: _capturedAt, camera: _view, selectedModelId: _selectedModel,
    selectedLayerId: _selectedLayer, selectedAnnotationId: _selectedAnnotation, thumbnail: _thumbnail, ...authorState } = scene;
  const assets = models.map(model => ({ id: model.id, status: model.status, geometry: model.manifest?.geometryUrl ?? null }));
  const canonical = canonicalJson({ scene: authorState, assets });
  if (last?.canonical === canonical) return last.key;
  const key = fingerprint64Labeled([["scene", authorState], ["assets", assets]]);
  last = { canonical, key };
  return key;
}
