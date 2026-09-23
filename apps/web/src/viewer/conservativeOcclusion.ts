import * as THREE from "three";
import { fullyOccluded, projectOcclusionBox, type OcclusionProjection } from "./occlusionProjection";
import { occlusionCompleteBoxDraw, occlusionOpaqueMaterial, solidBoxGeometry } from "./occlusionSolidGeometry";

interface ProjectedMesh { mesh: THREE.Mesh; projection: OcclusionProjection; triangles: number; }
const MAX_TARGETS = 512;
const MAX_BLOCKERS = 16;
const boundsCache = new WeakMap<THREE.BufferGeometry, { position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; version: number; box: THREE.Box3 }>();

/** 仅用经过实体检查的墙体挡住完全在后的静态网格；不修改作者可见性或阴影。 */
export class ConservativeOcclusion {
  readonly culled = new Set<THREE.Object3D>();
  private enabled = false;
  private revision = 0;
  /** 相机签名缓存：矩阵用数值逐位比较，避免每帧 32 次 float→string 与字符串拼接的 GC 压力。 */
  private readonly lastCameraWorld = new Float32Array(16);
  private readonly lastCameraProjection = new Float32Array(16);
  private lastRevision = -1;
  private lastLayersMask = -1;
  private lastExcludedUuid: string | undefined;
  private hasSignature = false;
  private lastCheckMs = 0;
  private blockers = 0;
  private candidates = 0;
  private avoidedTriangles = 0;
  private bypassReason = "disabled";
  private lastRecomputeAt = -Infinity;
  /** 剔除集仅对计算它的那一帧相机姿态有效；姿态变化或节流跳过时立即失效。 */
  private cullValid = false;

  setEnabled(enabled: boolean): void { this.enabled = enabled; this.invalidate(); if (!enabled) this.reset("disabled"); }
  invalidate(): void { this.revision++; this.hasSignature = false; this.culled.clear(); this.cullValid = false; }
  diagnostics() {
    return { enabled: this.enabled, culledMeshes: this.culled.size, blockers: this.blockers, candidates: this.candidates,
      avoidedTriangles: this.avoidedTriangles, checkMs: this.lastCheckMs, bypassReason: this.bypassReason };
  }

  update(root: THREE.Object3D, camera: THREE.Camera, dynamic: boolean, excluded?: THREE.Object3D,
    options?: { readonly minIntervalMs?: number }): void {
    if (!this.enabled || dynamic) { this.reset(this.enabled ? "dynamic-scene" : "disabled"); return; }
    camera.updateWorldMatrix(true, false);
    if (!this.cameraSignatureChanged(camera, excluded) && this.cullValid) return;
    const minIntervalMs = options?.minIntervalMs ?? 0;
    const now = performance.now();
    if (minIntervalMs > 0 && now - this.lastRecomputeAt < minIntervalMs) {
      if (this.culled.size > 0) {
        // 相机运动中的节流帧：非空剔除集绝不带过期姿态继续应用（防过度剔除），本帧全量绘制。
        this.reset(""); this.bypassReason = "camera-moving"; this.cullValid = false; return;
      }
      // 空剔除集与“跳过重算”输出恒等（全量绘制），直接保留，避免每帧重算也避免合批组振荡。
      this.bypassReason = "camera-moving";
      return;
    }
    this.lastRecomputeAt = now;
    const start = performance.now();
    this.reset("");
    root.updateWorldMatrix(true, true);
    const blockers: ProjectedMesh[] = [];
    const candidates: Array<{ mesh: THREE.Mesh; triangles: number }> = [];
    root.traverseVisible(object => {
      const mesh = object as THREE.Mesh;
      if (!eligible(mesh, camera) || isDescendant(mesh, excluded)) return;
      const triangles = (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count) / 3;
      const solidBox = solidBoxGeometry(mesh.geometry);
      if (solidBox && occlusionOpaqueMaterial(mesh.material) && occlusionCompleteBoxDraw(mesh.geometry, mesh.material)) {
        const projection = projectOcclusionBox(solidBox, mesh.matrixWorld, camera);
        if (projection && projection.area > 0.002) blockers.push({ mesh, projection, triangles });
      }
      // 小三角形对象的省下绘制成本不足以抵消投影检查。
      if (triangles >= 64) candidates.push({ mesh, triangles });
    });
    blockers.sort((a, b) => b.projection.area - a.projection.area);
    blockers.length = Math.min(blockers.length, MAX_BLOCKERS);
    this.blockers = blockers.length;
    if (blockers.length) {
      candidates.sort((a, b) => b.triangles - a.triangles);
      for (const { mesh, triangles } of candidates.slice(0, MAX_TARGETS)) {
        this.candidates++;
        const box = targetBounds(mesh.geometry);
        const target = box && projectOcclusionBox(box, mesh.matrixWorld, camera);
        if (target && blockers.some(blocker => blocker.mesh !== mesh && fullyOccluded(target, blocker.projection))) {
          this.culled.add(mesh); this.avoidedTriangles += triangles;
        }
      }
    }
    this.lastCheckMs = performance.now() - start;
    this.cullValid = true;
  }

  dispose(): void { this.reset("disposed"); }
  /** 与旧字符串签名逐位等价：revision、layers、相机世界/投影矩阵 16 个 float、被排除对象 uuid 全部一致才跳过。 */
  private cameraSignatureChanged(camera: THREE.Camera, excluded?: THREE.Object3D): boolean {
    const excludedUuid = excluded?.uuid;
    const world = camera.matrixWorld.elements, projection = camera.projectionMatrix.elements;
    if (this.hasSignature && this.lastRevision === this.revision && this.lastLayersMask === camera.layers.mask
      && this.lastExcludedUuid === excludedUuid
      && sameElements(this.lastCameraWorld, world) && sameElements(this.lastCameraProjection, projection)) return false;
    this.lastRevision = this.revision;
    this.lastLayersMask = camera.layers.mask;
    this.lastExcludedUuid = excludedUuid;
    this.lastCameraWorld.set(world);
    this.lastCameraProjection.set(projection);
    this.hasSignature = true;
    return true;
  }
  private reset(reason: string): void {
    this.culled.clear(); this.blockers = 0; this.candidates = 0; this.avoidedTriangles = 0; this.bypassReason = reason;
    if (reason) this.hasSignature = false;
    this.cullValid = false;
  }
}

function sameElements(snapshot: Float32Array, elements: number[]): boolean {
  for (let index = 0; index < 16; index += 1) if (snapshot[index] !== elements[index]) return false;
  return true;
}

function eligible(mesh: THREE.Mesh, camera: THREE.Camera): boolean {
  return mesh.isMesh === true && mesh.type === "Mesh" && mesh.layers.test(camera.layers)
    && mesh.geometry?.getAttribute("position") !== undefined && !Object.keys(mesh.geometry.morphAttributes).length
    && !mesh.morphTargetInfluences && !mesh.userData.effectHelper && !mesh.userData.layerDeleted
    && mesh.onBeforeRender === THREE.Object3D.prototype.onBeforeRender && mesh.onAfterRender === THREE.Object3D.prototype.onAfterRender
    && (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every(material =>
      !(material as THREE.ShaderMaterial).isShaderMaterial && !(material as THREE.MeshStandardMaterial).displacementMap
      && material.depthTest && material.depthFunc === THREE.LessEqualDepth && !material.polygonOffset && !material.stencilWrite
      && material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile && material.onBeforeRender === THREE.Material.prototype.onBeforeRender);
}

function targetBounds(geometry: THREE.BufferGeometry): THREE.Box3 | undefined {
  const position = geometry.getAttribute("position");
  if (!position) return undefined;
  const version = "version" in position ? position.version : position.data.version, cached = boundsCache.get(geometry);
  if (cached?.position === position && cached.version === version) return cached.box;
  geometry.computeBoundingBox();
  if (!geometry.boundingBox) return undefined;
  const box = geometry.boundingBox.clone(); boundsCache.set(geometry, { position, version, box }); return box;
}

function isDescendant(object: THREE.Object3D, root?: THREE.Object3D): boolean {
  if (!root) return false;
  for (let item: THREE.Object3D | null = object; item; item = item.parent) if (item === root) return true;
  return false;
}
