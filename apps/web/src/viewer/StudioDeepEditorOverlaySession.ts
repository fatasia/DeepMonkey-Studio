import type * as THREE from "three";
import type { EditorOverlaySnapshot } from "@bim-studio/deep-engine/webgpu";
import { mergeDeepOverlayVertices } from "./deepOverlayPrimitives";
import { projectStudioEditorOverlay } from "./studioDeepEditorOverlay";

export class StudioDeepEditorOverlaySession {
  private current: EditorOverlaySnapshot | undefined;
  private revision = 0;
  read(roots: readonly THREE.Object3D[], camera: THREE.Camera, width: number, height: number, pixelRatio: number,
    primitives: readonly Float32Array[] = []): EditorOverlaySnapshot {
    const vertices = mergeDeepOverlayVertices(
      projectStudioEditorOverlay(roots, camera, width * pixelRatio, height * pixelRatio, pixelRatio), primitives);
    if (this.current && this.current.vertices.length === vertices.length
      && vertices.every((value, index) => value === this.current!.vertices[index])) return this.current;
    this.current = Object.freeze({ revision: ++this.revision, vertices });
    return this.current;
  }
  dispose(): void { this.current = undefined; }
}
