/** Display-referred sRGB colors; clip positions use WebGPU z in [0,w]. No depth test. */
export interface EditorOverlaySnapshot {
  readonly revision: number;
  /** Triangle list: clip xyzw + straight RGBA, eight float32 values per vertex. */
  readonly vertices: Float32Array<ArrayBuffer>;
}
export const EDITOR_OVERLAY_MAX_VERTICES = 196_608;

export function snapshotEditorOverlay(value: EditorOverlaySnapshot): EditorOverlaySnapshot {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || !(value.vertices instanceof Float32Array)
    || !(value.vertices.buffer instanceof ArrayBuffer) || value.vertices.length % 24 !== 0
    || value.vertices.length > EDITOR_OVERLAY_MAX_VERTICES * 8) throw new Error("Invalid editor overlay layout or budget.");
  const vertices = value.vertices.slice();
  for (let index = 0; index < vertices.length; index++) {
    const number = vertices[index]!;
    if (!Number.isFinite(number) || index % 8 >= 4 && (number < 0 || number > 1))
      throw new Error("Editor overlay requires finite positions and unit colors.");
  }
  return Object.freeze({ revision: value.revision, vertices });
}
