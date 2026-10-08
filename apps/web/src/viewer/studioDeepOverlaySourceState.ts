import * as THREE from "three";

/** Read the exact projection inputs, including direct array writes without needsUpdate. */
export function studioDeepOverlaySourceState(roots: readonly THREE.Object3D[], camera: THREE.Camera,
  width: number, height: number, pixelRatio: number, primitives: readonly Float32Array[]): readonly unknown[] {
  const state: unknown[] = [width, height, pixelRatio, camera.layers.mask];
  append(state, camera.projectionMatrix.elements); append(state, camera.matrixWorldInverse.elements);
  const seen = new Set<THREE.Object3D>();
  const visit = (object: THREE.Object3D): void => {
    if (!object.visible || seen.has(object)) return;
    seen.add(object);
    if (object.layers.test(camera.layers) && ((object as THREE.Mesh).isMesh || (object as THREE.Line).isLine)) {
      const draw = object as THREE.Mesh | THREE.Line, material = draw.material;
      state.push(object, object.renderOrder, (draw as THREE.LineSegments).isLineSegments,
        (draw as THREE.LineLoop).isLineLoop, (draw as THREE.Line).isLine, material);
      if (!Array.isArray(material)) {
        state.push(material.visible, material.depthTest, material.opacity);
        if (material.visible && !material.depthTest && material.opacity !== 0) {
          const basic = material as THREE.MeshBasicMaterial & THREE.LineDashedMaterial;
          state.push(Object.getPrototypeOf(material), material.transparent, material.toneMapped,
            material.blending, basic.map, basic.vertexColors, material.side,
            basic.color?.r, basic.color?.g, basic.color?.b, basic.wireframe, basic.linewidth,
            basic.wireframeLinewidth, basic.scale, basic.dashSize, basic.gapSize, draw.geometry);
          append(state, object.matrixWorld.elements);
          const geometry = draw.geometry;
          state.push(geometry.drawRange.start, geometry.drawRange.count);
          attribute(state, geometry.getAttribute("position"), 3);
          attribute(state, geometry.index, 1);
          if (material instanceof THREE.LineDashedMaterial) attribute(state, geometry.getAttribute("lineDistance"), 1);
        }
      }
    }
    object.children.forEach(visit);
  };
  for (const root of roots) {
    let visible = true;
    for (let parent = root.parent; parent; parent = parent.parent) visible &&= parent.visible;
    if (visible) visit(root);
  }
  for (const primitive of primitives) { state.push(primitive.length); append(state, primitive); }
  return state;
}

function append(state: unknown[], values: ArrayLike<number>): void {
  for (let index = 0; index < values.length; index++) state.push(values[index]);
}

function attribute(state: unknown[], value: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined,
  components: number): void {
  state.push(value, value?.itemSize, value?.count);
  // Invalid inputs still reach the existing projection validator without an unbounded scan.
  if (!value || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 196_608) return;
  for (let index = 0; index < value.count; index++) {
    state.push(value.getX(index));
    if (components === 3) state.push(value.getY(index), value.getZ(index));
  }
}
