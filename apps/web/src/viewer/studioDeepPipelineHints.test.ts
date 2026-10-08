import * as THREE from "three";
import { expect, it } from "vitest";
import { studioDeepPipelineHints } from "./studioDeepPipelineHints";

it("classifies posed textured glass without reading texture pixels or vertex arrays", () => {
  const material = new THREE.MeshPhysicalMaterial({ transmission: 0.8, transparent: true, side: THREE.DoubleSide });
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), material), root = new THREE.Group();
  root.add(mesh); root.updateMatrixWorld(true);
  expect(studioDeepPipelineHints(root, 1)).toEqual({ firstFrameSubset: true, firstFrameMainKeys: [],
    deferDeformation: false, deformationFirstFrameMainKeys: ["material/blend/double"] });
});
it("deduplicates static mirrored normal-map keys and excludes hidden objects", () => {
  const material = new THREE.MeshStandardMaterial({ normalMap: new THREE.Texture(), alphaToCoverage: true });
  const root = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material); mesh.scale.x = -1; root.add(mesh);
  }
  const hidden = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  hidden.visible = false; root.add(hidden); root.updateMatrixWorld(true);
  expect(studioDeepPipelineHints(root, 1)?.firstFrameMainKeys).toEqual(["normal/depth/cw/a2c"]);
});
it("uses the authoritative path when no usable scheduling hint exists", () => {
  const root = new THREE.Group();
  expect(studioDeepPipelineHints(root, 1)).toBeUndefined();
  root.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial()));
  expect(studioDeepPipelineHints(root, 1)).toBeUndefined();
});
