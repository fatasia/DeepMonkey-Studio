import type { DeformationPose, DeformationSnapshot, DeformationSource } from "../deformation/types.js";
import type { GpuMorphSource } from "../webgpu/gpuMorphTypes.js";
import { attribute, component, sameStamp } from "./attributes.js";
import { captureAuthorMorphSource, type AuthorMorphSource } from "./authorMorphSource.js";
import { captureAuthorSkinPalette } from "./authorSkinPose.js";
import { shouldSampleAuthorPose, type AuthorPoseLod } from "./authorPoseLod.js";
import type { CachedGeometry } from "./geometries.js";
import { invalid, record } from "./types.js";

interface SourceCache { stamp: readonly unknown[]; source: DeformationSource; morph?: AuthorMorphSource; }

/** 只采作者已经推进的姿态；静态数组按 attribute version 缓存，候选随宿主 acknowledge 发布。 */
export class ThreeDeformationProjector {
  private acceptedSources = new Map<string, SourceCache>();
  private acceptedPoses = new Map<string, DeformationPose>();
  private sources = new Map<string, SourceCache>();
  private poses = new Map<string, DeformationPose>();
  private acceptedSnapshot: DeformationSnapshot | undefined;
  private acceptedFrame = 0;
  private acceptedSamples = new Map<string, number>();
  private acceptedTransforms = new Map<string, Float64Array>();
  private transforms = new Map<string, Float64Array>();
  private samples = new Map<string, number>();
  private visited = new Set<string>();

  begin(): void { this.sources = new Map(); this.poses = new Map(); this.samples = new Map(this.acceptedSamples);
    this.transforms = new Map(this.acceptedTransforms); this.visited.clear(); }
  clear(): void { this.begin(); this.acceptedSources.clear(); this.acceptedPoses.clear(); this.acceptedSnapshot = undefined;
    this.acceptedSamples.clear(); this.samples.clear(); this.acceptedTransforms.clear(); this.transforms.clear(); this.acceptedFrame = 0; }

  project(object: unknown, objectId: string, geometry: CachedGeometry, tier: AuthorPoseLod = "precise"): string | undefined {
    const owner = record(object, "deformation owner"), g = record(owner.geometry, "geometry");
    const morphAttributes = record(g.morphAttributes, "morph attributes");
    const morph = Object.keys(morphAttributes).length > 0, skin = owner.isSkinnedMesh === true;
    if (!morph && !skin) return undefined;
    const sourceId = `${geometry.resource.id}/${skin ? "skin" : "morph"}`;
    let cached = this.sources.get(sourceId);
    if (!cached) {
      const attrs = record(g.attributes, "skin attributes");
      const stamp: unknown[] = [geometry, g.morphTargetsRelative, morph, skin];
      if (skin) stamp.push(...attribute(attrs.skinIndex, 4, "skinIndex").stamp, ...attribute(attrs.skinWeight, 4, "skinWeight").stamp);
      for (const key of Object.keys(morphAttributes).sort()) {
        const targets = morphAttributes[key];
        if (!Array.isArray(targets)) invalid("morph attributes");
        stamp.push(key, targets.length);
        for (const target of targets) stamp.push(...attribute(target, 3, `morph ${key}`).stamp);
      }
      const previous = this.acceptedSources.get(sourceId);
      cached = previous && sameStamp(previous.stamp, stamp) ? previous
        : this.captureSource(g, geometry, sourceId, (previous?.source.revision ?? -1) + 1, stamp, morph, skin);
      this.sources.set(sourceId, cached);
    }
    const poseId = `${objectId}/${sourceId}`;
    if (this.poses.has(poseId)) return poseId;
    this.visited.add(poseId);
    const previous = this.acceptedPoses.get(poseId), revision = (previous?.revision ?? -1) + 1;
    const world = skin ? record(owner.matrixWorld, "mesh matrixWorld").elements as ArrayLike<number> : undefined;
    const oldTransform = this.acceptedTransforms.get(poseId);
    const transformChanged = world && (!oldTransform || world.length !== 16
      || oldTransform.some((component, index) => component !== world[index]));
    if (skin && previous && cached === this.acceptedSources.get(sourceId) && !morph
      && !transformChanged && !shouldSampleAuthorPose(tier, this.acceptedSamples.get(poseId), this.acceptedFrame)) {
      this.poses.set(poseId, previous);
      return poseId;
    }
    const morphWeights = cached.morph?.captureWeights(object, revision);
    const palette = skin ? captureAuthorSkinPalette(object, revision, previous?.palette) : undefined;
    if (skin) {
      this.samples.set(poseId, this.acceptedFrame + 1);
      if (world && world.length === 16) this.transforms.set(poseId, Float64Array.from(world));
    }
    const unchanged = previous && equal(previous.morphWeights?.values, morphWeights?.values)
      && (skin ? palette === previous.palette || equal(previous.palette?.matrices, palette?.matrices)
        && equal(previous.palette?.normalMatrices, palette?.normalMatrices) : true);
    this.poses.set(poseId, unchanged ? previous : { id: poseId, source: sourceId, revision,
      ...(morphWeights ? { morphWeights } : {}), ...(palette ? { palette } : {}) });
    return poseId;
  }

  snapshot(): DeformationSnapshot | undefined {
    if (!this.sources.size) return undefined;
    const stable = !this.requiresFullUpdate();
    return { sources: stable && this.acceptedSnapshot ? this.acceptedSnapshot.sources : [...this.sources.values()].map(value => value.source),
      poses: [...this.poses.values()] };
  }

  requiresFullUpdate(): boolean {
    return this.sources.size !== this.acceptedSources.size || this.poses.size !== this.acceptedPoses.size
      || [...this.sources].some(([id, value]) => this.acceptedSources.get(id) !== value)
      || [...this.poses].some(([id, value]) => {
        const previous = this.acceptedPoses.get(id);
        return !previous || previous.palette?.matrices.length !== value.palette?.matrices.length;
      });
  }

  accept(snapshot: DeformationSnapshot | undefined): void {
    this.acceptedSources = this.sources; this.acceptedPoses = this.poses; this.acceptedSnapshot = snapshot;
    for (const poseId of this.acceptedSamples.keys()) if (!this.visited.has(poseId)) {
      this.samples.delete(poseId); this.transforms.delete(poseId);
    }
    this.acceptedSamples = this.samples; this.acceptedTransforms = this.transforms;
    this.acceptedFrame++;
  }

  private captureSource(g: Record<string, unknown>, geometry: CachedGeometry, id: string, revision: number,
    stamp: readonly unknown[], hasMorph: boolean, hasSkin: boolean): SourceCache {
    const captured = hasMorph ? captureAuthorMorphSource(g, { id, revision,
      ...(geometry.vertexRemap ? { vertexRemap: geometry.vertexRemap } : {}) }) : undefined;
    // 切线生成属于静态几何准备；morph/skin 输出必须使用最终压紧后的同一切线顺序。
    let morph: GpuMorphSource | undefined;
    if (captured) {
      const { tangents: _authoredTangents, ...base } = captured.source;
      morph = { ...base, ...(geometry.resource.tangents ? { tangents: geometry.resource.tangents } : {}) };
    }
    const skinning = hasSkin ? captureSkinSource(g, geometry, revision) : undefined;
    return { stamp, ...(captured ? { morph: captured } : {}), source: {
      id, revision, geometry: geometry.resource.id, semantics: "three-r185",
      kind: hasMorph ? hasSkin ? "morph-skin" : "morph" : "skin",
      ...(morph ? { morph } : {}), ...(skinning ? { skinning } : {}),
    } };
  }
}

function captureSkinSource(g: Record<string, unknown>, geometry: CachedGeometry, revision: number) {
  const attrs = record(g.attributes, "skin attributes");
  const jointsView = attribute(attrs.skinIndex, 4, "skinIndex"), weightsView = attribute(attrs.skinWeight, 4, "skinWeight");
  const count = attribute(attrs.position, 3, "position").count;
  if (jointsView.count !== count || weightsView.count !== count || jointsView.normalized) invalid("skin attribute count/normalization");
  const vertices = geometry.resource.vertices, outputCount = vertices.length / 6;
  const positions = new Float32Array(outputCount * 3), normals = new Float32Array(outputCount * 3);
  const joints = new Uint32Array(outputCount * 4), weights = new Float32Array(outputCount * 4);
  for (let vertex = 0; vertex < outputCount; vertex++) {
    positions.set(vertices.subarray(vertex * 6, vertex * 6 + 3), vertex * 3);
    normals.set(vertices.subarray(vertex * 6 + 3, vertex * 6 + 6), vertex * 3);
    for (let lane = 0; lane < 4; lane++) {
      const original = geometry.vertexRemap?.[vertex] ?? vertex;
      const joint = component(jointsView, original, lane);
      if (!Number.isSafeInteger(joint) || joint < 0 || joint >= 65_535) invalid("skin joint index");
      joints[vertex * 4 + lane] = joint; weights[vertex * 4 + lane] = component(weightsView, original, lane);
    }
  }
  return { revision, positions, normals, joints, weights, weightMode: "preserve" as const,
    ...(geometry.resource.tangents ? { tangents: geometry.resource.tangents.slice() } : {}) };
}

function equal(a: Float32Array | undefined, b: Float32Array | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);
}
