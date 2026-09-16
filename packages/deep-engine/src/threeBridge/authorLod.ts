import type { RenderInstance, RenderAuthorSelectedLodProfile } from "../renderPacketTypes.js";
import { invalid, record, unsupported, type ThreeObjectSource } from "./types.js";

interface AuthorLevel { readonly object: ThreeObjectSource; readonly distance: number; readonly hysteresis: number }
/** Reads Three's authoritative visibility; never invokes LOD.update or changes author state. */
export class ThreeAuthorLodProjector {
  private states = new WeakMap<object, { signature: string; revision: number }>();
  project(object: ThreeObjectSource, cameraLayerMask: number,
    extract: (level: ThreeObjectSource) => readonly RenderInstance[], geometryRevision: (id: string) => number): RenderInstance | undefined {
    const source = record(object, "LOD"), raw = source.levels;
    if (typeof source.autoUpdate !== "boolean" || !Array.isArray(raw) || raw.length < 1 || raw.length > 8) invalid("LOD levels/autoUpdate");
    const levels = raw as AuthorLevel[], seen = new Set<ThreeObjectSource>(); let prior = -1;
    for (const level of levels) {
      if (!level || !level.object || !Number.isFinite(level.distance) || level.distance < prior || level.distance < 0
        || !Number.isFinite(level.hysteresis) || level.hysteresis < 0 || level.hysteresis > 1) invalid("LOD distance/hysteresis");
      const child = record(level.object, "LOD level");
      if (seen.has(level.object) || child.parent !== object) invalid("LOD level ownership");
      seen.add(level.object); prior = level.distance;
      if (child.type !== "Mesh" || child.isInstancedMesh || child.isSkinnedMesh || child.morphTargetInfluences
        || !Array.isArray(child.children) || child.children.length || Array.isArray(child.material)) unsupported("LOD level mesh/material composition");
    }
    if (!Array.isArray(object.children) || object.children.length !== levels.length || object.children.some(child => !seen.has(child)))
      unsupported("LOD additional children");
    const first = record(levels[0]!.object, "LOD primary"), material = record(first.material, "LOD material");
    for (const level of levels) {
      const child = record(level.object, "LOD level");
      if (child.material !== first.material || child.castShadow !== first.castShadow || child.receiveShadow !== first.receiveShadow
        || !Array.from(level.object.matrixWorld.elements).every((v, index) => v === levels[0]!.object.matrixWorld.elements[index]))
        unsupported("LOD incompatible level material/transform/shadow state");
    }
    if (material.visible === false) return;
    const instances = levels.map(level => {
      const projected = extract(level.object);
      if (projected.length !== 1 || projected[0]!.pose !== undefined) unsupported("LOD level draw slices/deformation");
      return projected[0]!;
    });
    if (new Set(instances.map(instance => instance.geometry)).size !== instances.length) unsupported("LOD duplicated level geometry");
    const selectedLevels = levels.flatMap((level, index) => level.object.visible && (level.object.layers.mask & cameraLayerMask) !== 0 ? [index] : []);
    const descriptors = levels.map((level, index) => ({ geometry: instances[index]!.geometry, distance: level.distance, hysteresis: level.hysteresis }));
    const signature = JSON.stringify([descriptors, selectedLevels, instances.map(instance => geometryRevision(instance.geometry))]);
    const previous = this.states.get(object), revision = previous?.signature === signature ? previous.revision : (previous?.revision ?? -1) + 1;
    this.states.set(object, { signature, revision });
    const lod: RenderAuthorSelectedLodProfile = Object.freeze({ strategy: "author-selected", revision,
      levels: Object.freeze(descriptors.map(level => Object.freeze(level))), selectedLevels: Object.freeze(selectedLevels) });
    return { ...instances[0]!, lod };
  }
  clear(): void { this.states = new WeakMap(); }
}
