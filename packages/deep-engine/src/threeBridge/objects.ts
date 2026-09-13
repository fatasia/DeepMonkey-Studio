import { invalid, limit, record, unsupported, type ThreeObjectSource, type ThreeProjectionHooks } from "./types.js";

export function inspectObject(object: ThreeObjectSource, hooks: ThreeProjectionHooks): "mesh" | "container" {
  const o = object as unknown as Record<string, unknown>;
  if (o.renderOrder !== 0) unsupported("object render order");
  if (o.isScene) {
    for (const key of ["background", "environment", "fog", "overrideMaterial"]) if (o[key] != null) unsupported(`scene.${key}`);
  }
  if (o.isMesh) {
    if (o.isSkinnedMesh || o.isBatchedMesh || o.type !== "Mesh" && o.type !== "InstancedMesh") unsupported("mesh type");
    if (o.onBeforeRender !== hooks.objectBeforeRender || o.onAfterRender !== hooks.objectAfterRender
      || o.onBeforeShadow !== hooks.objectBeforeShadow || o.onAfterShadow !== hooks.objectAfterShadow
      || o.customDepthMaterial || o.customDistanceMaterial) unsupported("object render hooks");
    if (o.morphTargetInfluences) unsupported("morph targets");
    // 当前 packet 没有逐物体阴影合同，不能把启用阴影的作者配置默默丢弃。
    if (o.castShadow || o.receiveShadow) unsupported("object shadow flags");
    if (o.instanceColor || o.morphTexture) unsupported("instance colors or morphs");
    return "mesh";
  }
  if (o.isCamera || ["Object3D", "Group", "Scene"].includes(object.type)) return "container";
  unsupported(`object type ${object.type}`);
}
export function objectTransforms(object: ThreeObjectSource): readonly Float64Array[] {
  const o = object as unknown as Record<string, unknown>;
  const world = object.matrixWorld.elements;
  if (world.length !== 16) invalid("world transform");
  if (!o.isInstancedMesh) return [Float64Array.from(world)];
  const attr = record(o.instanceMatrix, "instance matrix");
  const array = attr.array;
  const count = o.count as number, capacity = attr.count as number;
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(capacity) || capacity < count || attr.itemSize !== 16
    || !(array instanceof Float32Array) || array.length < capacity * 16 || attr.normalized !== false) invalid("instance matrix layout");
  if (count > 16_384) limit("instances");
  if (typeof SharedArrayBuffer !== "undefined" && array.buffer instanceof SharedArrayBuffer) unsupported("shared instance matrices");
  const result: Float64Array[] = [];
  for (let instance = 0; instance < count; instance++) {
    const out = new Float64Array(16), start = instance * 16;
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let k = 0; k < 4; k++) value += world[k * 4 + row]! * array[start + column * 4 + k]!;
      out[column * 4 + row] = value;
    }
    result.push(out);
  }
  return result;
}
