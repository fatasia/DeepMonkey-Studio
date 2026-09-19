import type { Document, Mesh, Primitive } from "@gltf-transform/core";

/** 静态光照属于场景实例；仅分离会被改写的 mesh/primitive，保持几何、材质和节点身份。 */
export function separateLightmapInstances(document: Document): boolean {
  const meshes = new Set<Mesh>(), primitives = new Set<Primitive>();
  let changed = false;
  for (const node of document.getRoot().listNodes()) {
    let mesh = node.getMesh();
    if (!mesh) continue;
    if (meshes.has(mesh)) {
      mesh = mesh.clone();
      node.setMesh(mesh);
      changed = true;
    }
    meshes.add(mesh);
    const sources = mesh.listPrimitives();
    const unique = sources.map(primitive => {
      if (!primitives.has(primitive)) {
        primitives.add(primitive);
        return primitive;
      }
      changed = true;
      const copy = primitive.clone();
      primitives.add(copy);
      return copy;
    });
    if (unique.some((primitive, index) => primitive !== sources[index])) {
      for (const primitive of sources) mesh.removePrimitive(primitive);
      for (const primitive of unique) mesh.addPrimitive(primitive);
    }
  }
  return changed;
}
