import { prepareInstanceUpdate, type PbrMaterial, type RenderInstance, type RenderPacket } from "../renderPacket.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import { geometryView, projectGeometry, type CachedGeometry } from "./geometries.js";
import { ThreeDeformationProjector } from "./deformationProjector.js";
import { ThreeAuthorLodProjector } from "./authorLod.js";
import { materialVisible, projectMaterial, type ProjectedMaterial } from "./materials.js";
import { inspectObject, objectTransforms } from "./objects.js";
import { ThreeTextureProjector } from "./textures.js";
import { ProjectionFailure, invalid, limit, unsupported, type IncrementalProjectionResult, type ProjectionIssue, type ProjectionResult, type ThreeObjectSource, type ThreeProjectionHooks } from "./types.js";
import type { ThreeProjectionDirtyPlan } from "./SceneChangesetProjection.js";

type ReadyDirtyPlan = Extract<ThreeProjectionDirtyPlan, { readonly status: "ready" }>;
interface ProjectionTopology { readonly order: readonly ThreeObjectSource[]; readonly parents: ReadonlyMap<ThreeObjectSource, ThreeObjectSource | undefined> }

/** 仅持有可重建的渲染快照。作者图、资源 dispose、脚本与 world matrix 更新均归原宿主。 */
export class ThreeProjectionBridge {
  private readonly identities = new WeakMap<object, number>();
  private nextIdentity = 0;
  private epoch = 0;
  private accepted = new Map<string, CachedGeometry>();
  private acceptedMaterials = new Map<string, ProjectedMaterial>();
  private acceptedTextures = new Map<string, DecodedTexture>();
  private acceptedFragments = new Map<ThreeObjectSource, readonly RenderInstance[]>();
  private acceptedTopology: ProjectionTopology | undefined;
  private acceptedRoot: ThreeObjectSource | undefined;
  private acceptedCameraLayerMask: number | undefined;
  private acceptedInstanceSources = new Map<string, ThreeObjectSource>();
  private initialized = false;
  private readonly hooks: ThreeProjectionHooks;
  private readonly textureProjector = new ThreeTextureProjector(source => this.id(source, "texture"));
  private readonly deformationProjector = new ThreeDeformationProjector();
  private readonly authorDeformation: boolean;
  private readonly authorLod: boolean;
  private readonly lodProjector = new ThreeAuthorLodProjector();

  constructor(options: { readonly hooks: ThreeProjectionHooks; readonly capabilities?: { readonly authorDeformation?: boolean; readonly authorLod?: boolean } }) {
    const keys: readonly (keyof ThreeProjectionHooks)[] = ["objectBeforeRender", "objectAfterRender", "objectBeforeShadow", "objectAfterShadow", "materialBeforeRender", "materialBeforeCompile", "materialProgramCacheKey"];
    for (const key of keys) if (typeof options.hooks[key] !== "function") throw new Error("Three projection requires default prototype hooks.");
    this.hooks = { ...options.hooks };
    this.authorDeformation = options.capabilities?.authorDeformation === true;
    this.authorLod = options.capabilities?.authorLod === true;
  }

  /** Resolve an already projected author object without allocating a new projection identity. */
  objectIdFor(object: ThreeObjectSource): string | undefined {
    const id = this.identities.get(object);
    return id === undefined ? undefined : `object-${id}`;
  }

  /** 数组原位改动遵循 Three needsUpdate/version；替换 attribute / data / array 也自动失效。 */
  project(root: ThreeObjectSource, options: { readonly cameraLayerMask: number }): ProjectionResult {
    const epoch = ++this.epoch;
    this.textureProjector.beginProjection();
    this.deformationProjector.begin();
    const candidates = new Map<string, CachedGeometry>(), materials = new Map<string, ProjectedMaterial>();
    const textures = new Map<string, DecodedTexture>(), instances: RenderInstance[] = [];
    const fragments = new Map<ThreeObjectSource, readonly RenderInstance[]>();
    const issues: ProjectionIssue[] = [], seen = new Set<ThreeObjectSource>();
    const stack = [{ object: root, path: "root" }];
    const budget = { bytes: 0 };
    const addIssue = (error: unknown, objectId: string, path: string) => {
      const e = error instanceof ProjectionFailure ? error : new ProjectionFailure("invalid", "packet", error instanceof Error ? error.message : "Invalid Three source.");
      issues.push({ code: e.code, objectId, path, feature: e.feature, message: e.message });
    };
    if (!Number.isInteger(options.cameraLayerMask) || options.cameraLayerMask < -2147483648 || options.cameraLayerMask > 4294967295) {
      addIssue(new ProjectionFailure("invalid", "camera layers", "Invalid camera layer mask."), "", "cameraLayerMask");
    }
    while (stack.length && issues.length < 32) {
      const { object, path } = stack.pop()!;
      const objectId = this.id(object, "object");
      try {
        if (seen.has(object)) invalid("object tree cycle or duplicate child");
        seen.add(object);
        if (seen.size > 32_768) limit("objects");
        if (!object.visible) continue;
        if (object.type === "Scene") inspectObject(object, this.hooks);
        // 父级 layer 不匹配不会隐藏子级；visible=false 则剪去整个子树，与 Three 一致。
        if ((object.layers.mask & options.cameraLayerMask) !== 0 || this.authorLod && object.type === "LOD") {
          const kind = inspectObject(object, this.hooks, this.authorDeformation, this.authorLod);
          if (kind === "mesh") {
            const start = instances.length;
            this.extract(object, objectId, candidates, materials, textures, instances, budget);
            fragments.set(object, Object.freeze(instances.slice(start)));
          }
          if (kind === "lod") {
            const instance = this.lodProjector.project(object, options.cameraLayerMask, level => {
              if (seen.has(level)) invalid("object tree cycle or duplicate child");
              seen.add(level);
              if (seen.size > 32_768) limit("objects");
              inspectObject(level, this.hooks, false);
              const projected: RenderInstance[] = [];
              this.extract(level, objectId, candidates, materials, textures, projected, budget);
              return projected;
            }, id => candidates.get(id)!.resource.revision);
            if (instance) instances.push(instance);
            continue;
          }
        }
        if (!Array.isArray(object.children)) invalid("object children");
        for (let i = object.children.length - 1; i >= 0; i--) stack.push({ object: object.children[i]!, path: `${path}.children[${i}]` });
      } catch (error) { addIssue(error, objectId, path); }
      if (seen.size > 32_768) break;
    }
    const deformation = this.deformationProjector.snapshot();
    const packet: RenderPacket = { geometries: [...candidates.values()].map(c => c.resource),
      materials: [...materials.values()].map(projected => projected.material),
      instances, textures: [...textures.values()], ...(deformation ? { deformation } : {}) };
    if (!issues.length) try {
      if (candidates.size > 4096) limit("geometries");
      if (textures.size > 4096 || [...textures.values()].reduce((sum, texture) => sum + texture.data.byteLength, 0) > 128 * 1024 * 1024) limit("textures");
      prepareInstanceUpdate(new Map([...candidates].map(([id, value]) => [id,
        { uv0: value.resource.uv0 !== undefined, uv1: value.resource.uv1 !== undefined,
          tangents: value.resource.tangents !== undefined, colors: value.resource.colors !== undefined,
          triangles: value.resource.indices.length / 3 }])), { ...packet, ...(deformation ? { poses: deformation.poses } : {}) },
        new Map([...textures].map(([id, value]) => [id, value.semantic])), deformation);
    } catch (error) { addIssue(error, "", "packet"); }
    if (issues.length) return { ok: false, issues };
    const topology = this.topology(root);
    const full = !this.initialized || this.deformationProjector.requiresFullUpdate() || candidates.size !== this.accepted.size
      || [...candidates].some(([key, value]) => this.accepted.get(key) !== value)
      || textures.size !== this.acceptedTextures.size
      || [...textures].some(([key, value]) => this.acceptedTextures.get(key) !== value);
    let settled = false;
    return { ok: true, packet, update: full ? "full" : "instances", acknowledge: () => {
      if (settled || epoch !== this.epoch) return false;
      settled = true; this.accepted = candidates; this.acceptedMaterials = materials; this.acceptedTextures = textures;
      this.acceptedFragments = fragments; this.acceptedTopology = topology; this.acceptedRoot = root;
      this.acceptedCameraLayerMask = options.cameraLayerMask; this.textureProjector.acceptProjection();
      this.acceptedInstanceSources = buildInstanceSourceMap(topology?.order ?? [], this.acceptedFragments, this.id.bind(this));
      this.deformationProjector.accept(deformation); this.initialized = true; return true;
    } };
  }

  /** Resolve a packed instance id back to its author object for host-side selection. */
  sourceForInstanceId(instanceId: string): ThreeObjectSource | undefined {
    return this.acceptedInstanceSources.get(instanceId);
  }

  /** Reprojects only SceneChangeset-owned dirty objects while retaining the accepted packet cache. */
  projectDirty(root: ThreeObjectSource, plan: ReadyDirtyPlan,
    options: { readonly cameraLayerMask: number }): IncrementalProjectionResult {
    const topology = this.acceptedTopology;
    if (!this.initialized || plan.metrics.fullFallback || root !== this.acceptedRoot
      || options.cameraLayerMask !== this.acceptedCameraLayerMask || !topology
      || this.authorDeformation || this.authorLod || plan.objects.some(object => !topology.parents.has(object))) {
      return this.projectFullFallback(root, plan, options);
    }
    const dirty = new Set(plan.objects), dirtyRoots = new Set(plan.objects);
    for (const object of plan.objects) for (const child of object.children) if (dirty.has(child)) dirtyRoots.delete(child);
    const sourceObjectCount = topology.order.length;
    const epoch = ++this.epoch; this.textureProjector.beginProjection(); this.deformationProjector.begin();
    const candidates = new Map<string, CachedGeometry>(), materials = new Map<string, ProjectedMaterial>();
    const textures = new Map<string, DecodedTexture>(), fragments = new Map(this.acceptedFragments);
    const issues: ProjectionIssue[] = [], budget = { bytes: 0 }; let rebuiltObjectCount = 0;
    for (const object of dirty) fragments.delete(object);
    const addIssue = (error: unknown, objectId: string, path: string) => {
      const e = error instanceof ProjectionFailure ? error : new ProjectionFailure("invalid", "packet", error instanceof Error ? error.message : "Invalid Three source.");
      issues.push({ code: e.code, objectId, path, feature: e.feature, message: e.message });
    };
    for (const dirtyRoot of dirtyRoots) {
      if (this.hiddenAncestor(dirtyRoot, dirty, topology.parents)) continue;
      const stack = [{ object: dirtyRoot, path: "dirty" }];
      while (stack.length && issues.length < 32) {
        const { object, path } = stack.pop()!; rebuiltObjectCount++;
        const objectId = this.id(object, "object");
        try {
          if (!dirty.has(object)) invalid("dirty domain descendants");
          if (!object.visible) continue;
          if (object.type === "Scene") inspectObject(object, this.hooks);
          if ((object.layers.mask & options.cameraLayerMask) !== 0) {
            const kind = inspectObject(object, this.hooks, false, false);
            if (kind === "mesh") {
              const projected: RenderInstance[] = [];
              this.extract(object, objectId, candidates, materials, textures, projected, budget);
              fragments.set(object, Object.freeze(projected));
            }
          }
          if (!Array.isArray(object.children)) invalid("object children");
          for (let index = object.children.length - 1; index >= 0; index--)
            stack.push({ object: object.children[index]!, path: `${path}.children[${index}]` });
        } catch (error) { addIssue(error, objectId, path); }
      }
    }
    const metrics = { mode: "incremental" as const, sourceObjectCount, rebuiltObjectCount,
      reusedObjectCount: Math.max(0, sourceObjectCount - dirty.size),
      allocatedInstanceCount: [...fragments].filter(([object]) => dirty.has(object)).reduce((sum, [, value]) => sum + value.length, 0) };
    if (issues.length) return { ok: false, issues, metrics };
    const allGeometry = new Map(this.accepted); for (const entry of candidates) allGeometry.set(...entry);
    const allMaterials = new Map(this.acceptedMaterials); for (const entry of materials) allMaterials.set(...entry);
    const allTextures = new Map(this.acceptedTextures); for (const entry of textures) allTextures.set(...entry);
    const instances = topology.order.flatMap(object => fragments.get(object) ?? []);
    const geometryIds = new Set(instances.map(instance => instance.geometry));
    const materialIds = new Set(instances.map(instance => instance.material));
    const packetMaterials = [...materialIds].map(id => allMaterials.get(id)?.material).filter((value): value is PbrMaterial => value !== undefined);
    const textureIds = new Set<string>();
    for (const material of packetMaterials) for (const slot of [material.baseColorTexture, material.metallicRoughnessTexture,
      material.normalTexture, material.occlusionTexture, material.emissiveTexture]) if (slot) textureIds.add(slot.texture);
    const packetGeometries = [...geometryIds].map(id => allGeometry.get(id)).filter((value): value is CachedGeometry => value !== undefined);
    const packetTextures = [...textureIds].map(id => allTextures.get(id)).filter((value): value is DecodedTexture => value !== undefined);
    if (packetGeometries.length !== geometryIds.size || packetMaterials.length !== materialIds.size || packetTextures.length !== textureIds.size) {
      return this.projectFullFallback(root, plan, options);
    }
    const packet: RenderPacket = { geometries: packetGeometries.map(value => value.resource), materials: packetMaterials,
      instances, textures: packetTextures };
    try {
      const bytes = packet.geometries.reduce((sum, value) => sum + value.vertices.byteLength + value.indices.byteLength
        + (value.uv0?.byteLength ?? 0) + (value.uv1?.byteLength ?? 0) + (value.tangents?.byteLength ?? 0) + (value.colors?.byteLength ?? 0), 0);
      if (bytes > 128 * 1024 * 1024) limit("packet geometry bytes");
      prepareInstanceUpdate(new Map(packetGeometries.map(value => [value.resource.id,
        { uv0: value.resource.uv0 !== undefined, uv1: value.resource.uv1 !== undefined,
          tangents: value.resource.tangents !== undefined, colors: value.resource.colors !== undefined,
          triangles: value.resource.indices.length / 3 }])), packet,
        new Map(packetTextures.map(value => [value.id, value.semantic])));
      this.textureProjector.completeProjection(packetTextures);
    } catch (error) { addIssue(error, "", "packet"); }
    if (issues.length) return { ok: false, issues, metrics };
    const full = geometryIds.size !== this.accepted.size || packetGeometries.some(value => this.accepted.get(value.resource.id) !== value)
      || textureIds.size !== this.acceptedTextures.size || packetTextures.some(value => this.acceptedTextures.get(value.id) !== value);
    let settled = false;
    return { ok: true, packet, update: full ? "full" : "instances", metrics, acknowledge: () => {
      if (settled || epoch !== this.epoch || !plan.acknowledge()) return false;
      settled = true; this.accepted = new Map(packetGeometries.map(value => [value.resource.id, value]));
      this.acceptedMaterials = new Map([...materialIds].map(id => [id, allMaterials.get(id)!]));
      this.acceptedTextures = new Map(packetTextures.map(value => [value.id, value])); this.acceptedFragments = fragments;
      this.acceptedInstanceSources = buildInstanceSourceMap(topology.order, this.acceptedFragments, this.id.bind(this));
      this.textureProjector.acceptProjection(); this.initialized = true; return true;
    } };
  }

  private projectFullFallback(root: ThreeObjectSource, plan: ReadyDirtyPlan,
    options: { readonly cameraLayerMask: number }): IncrementalProjectionResult {
    const result = this.project(root, options), epoch = this.epoch;
    const sourceObjectCount = this.topology(root)?.order.length ?? plan.metrics.boundNodeCount;
    const metrics = { mode: "full-fallback" as const, sourceObjectCount, rebuiltObjectCount: sourceObjectCount,
      reusedObjectCount: 0, allocatedInstanceCount: result.ok ? result.packet.instances.length : 0 };
    if (!result.ok) return { ...result, metrics };
    let settled = false;
    return { ...result, metrics, acknowledge: () => {
      if (settled || epoch !== this.epoch || !plan.acknowledge() || !result.acknowledge()) return false;
      settled = true; return true;
    } };
  }

  private hiddenAncestor(object: ThreeObjectSource, dirty: ReadonlySet<ThreeObjectSource>,
    parents: ReadonlyMap<ThreeObjectSource, ThreeObjectSource | undefined>): boolean {
    let parent = parents.get(object);
    while (parent) { if (!dirty.has(parent) && !parent.visible) return true; parent = parents.get(parent); }
    return false;
  }

  private topology(root: ThreeObjectSource): ProjectionTopology | undefined {
    const order: ThreeObjectSource[] = [], parents = new Map<ThreeObjectSource, ThreeObjectSource | undefined>();
    const stack: { object: ThreeObjectSource; parent: ThreeObjectSource | undefined }[] = [{ object: root, parent: undefined }];
    while (stack.length) {
      const { object, parent } = stack.pop()!;
      if (parents.has(object) || !Array.isArray(object.children) || order.length >= 32_768) return undefined;
      parents.set(object, parent); order.push(object);
      for (let index = object.children.length - 1; index >= 0; index--)
        stack.push({ object: object.children[index]!, parent: object });
    }
    return { order, parents };
  }

  /** 清理自己的投影，不触碰作者几何/材质，也不触发任何 dispose 事件。 */
  clear(): void { this.epoch++; this.accepted.clear(); this.acceptedMaterials.clear(); this.acceptedTextures.clear();
    this.acceptedFragments.clear(); this.acceptedTopology = undefined; this.acceptedRoot = undefined;
    this.acceptedCameraLayerMask = undefined; this.acceptedInstanceSources.clear(); this.textureProjector.clear(); this.deformationProjector.clear(); this.lodProjector.clear(); this.initialized = false; }

  private extract(object: ThreeObjectSource, objectId: string, geometries: Map<string, CachedGeometry>,
    materials: Map<string, ProjectedMaterial>,
    textures: Map<string, DecodedTexture>, instances: RenderInstance[], budget: { bytes: number }): void {
    const source = object as unknown as { geometry: unknown; material: unknown; castShadow?: boolean; receiveShadow?: boolean };
    if (!Array.isArray(source.material) && !materialVisible(source.material)) return;
    const view = geometryView(source.geometry, source.material, this.authorDeformation), transforms = objectTransforms(object);
    if (!transforms.length) return;
    for (const slice of view.slices) {
      if (!materialVisible(slice.material)) continue;
      if (instances.length + transforms.length > 16_384) limit("instances");
      const materialId = this.id(slice.material as object, "material");
      if (!materials.has(materialId)) {
        const projected = projectMaterial(slice.material, materialId, this.hooks, this.textureProjector);
        materials.set(materialId, projected);
        for (const texture of projected.textures) textures.set(texture.id, texture);
      }
      const projected = materials.get(materialId)!;
      const normalTexCoord = projected.material.normalTexture?.texCoord;
      if (projected.vertexColors && !view.color) invalid("material vertex colors without a geometry color stream");
      if (projected.flatShading && normalTexCoord !== undefined) unsupported("flat shading with normal map");
      // 同一 Three 几何可同时服务普通/法线贴图/顶点色/平面着色材质；派生差异必须用 ID 隔离。
      const geometryId = `${this.id(view.source, "geometry")}/${slice.start}/${slice.count}`
        + `${normalTexCoord === undefined ? "" : `/normal${normalTexCoord}`}${projected.vertexColors ? "/color" : ""}${projected.flatShading ? "/flat" : ""}`;
      if (!geometries.has(geometryId)) {
        if (geometries.size >= 4096) limit("geometries");
        const vertexCount = projected.flatShading ? slice.count : view.position.count;
        budget.bytes += vertexCount * (24 + (view.uv0 ? 8 : 0) + (view.uv1 ? 8 : 0) + (projected.vertexColors ? 16 : 0)
          + (normalTexCoord === undefined ? 0 : 16)) + slice.count * 4;
        if (budget.bytes > 128 * 1024 * 1024) limit("packet geometry bytes");
        geometries.set(geometryId, projectGeometry(view, slice, geometryId, this.accepted.get(geometryId), normalTexCoord,
          projected.flatShading, projected.vertexColors));
      }
      const pose = this.authorDeformation ? this.deformationProjector.project(object, objectId, geometries.get(geometryId)!) : undefined;
      transforms.forEach((transform, instance) => instances.push({ id: `${objectId}/${slice.slot}/${instance}`, geometry: geometryId, material: materialId, transform,
        ...(pose ? { pose } : {}),
        ...(source.castShadow === true ? {} : { castShadow: false }),
        ...(source.receiveShadow === true ? {} : { receiveShadow: false }) }));
    }
  }

  private id(value: object, prefix: string): string {
    let id = this.identities.get(value);
    if (id === undefined) { id = ++this.nextIdentity; this.identities.set(value, id); }
    return `${prefix}-${id}`;
  }
}

function buildInstanceSourceMap(order: readonly ThreeObjectSource[], fragments: ReadonlyMap<ThreeObjectSource, readonly RenderInstance[]>,
  objectId: (value: object, prefix: string) => string): Map<string, ThreeObjectSource> {
  const result = new Map<string, ThreeObjectSource>();
  for (const object of order) {
    const id = objectId(object, "object");
    for (const instance of fragments.get(object) ?? []) result.set(instance.id, object);
    // LOD projections reuse the parent identity, so prefix matching covers those instances too.
    for (const instance of fragments.get(object) ?? []) if (!result.has(`${id}/${instance.id}`)) result.set(`${id}/${instance.id}`, object);
  }
  return result;
}
