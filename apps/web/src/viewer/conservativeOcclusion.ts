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
  private lastSignature = "";
  private lastCheckMs = 0;
  private blockers = 0;
  private candidates = 0;
  private avoidedTriangles = 0;
  private bypassReason = "disabled";

  setEnabled(enabled: boolean): void { this.enabled = enabled; this.invalidate(); if (!enabled) this.reset("disabled"); }
  invalidate(): void { this.revision++; this.lastSignature = ""; this.culled.clear(); }
  diagnostics() {
    return { enabled: this.enabled, culledMeshes: this.culled.size, blockers: this.blockers, candidates: this.candidates,
      avoidedTriangles: this.avoidedTriangles, checkMs: this.lastCheckMs, bypassReason: this.bypassReason };
  }

  update(root: THREE.Object3D, camera: THREE.Camera, dynamic: boolean, excluded?: THREE.Object3D): void {
    if (!this.enabled || dynamic) { this.reset(this.enabled ? "dynamic-scene" : "disabled"); return; }
    camera.updateWorldMatrix(true, false);
    const signature = `${this.revision}:${camera.layers.mask}:${camera.matrixWorld.elements.join(",")}:${camera.projectionMatrix.elements.join(",")}:${excluded?.uuid ?? ""}`;
    if (signature === this.lastSignature) return;
    const start = performance.now();
    this.reset(""); this.lastSignature = signature;
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
  }

  dispose(): void { this.reset("disposed"); }
  private reset(reason: string): void {
    this.culled.clear(); this.blockers = 0; this.candidates = 0; this.avoidedTriangles = 0; this.bypassReason = reason;
    if (reason) this.lastSignature = "";
  }
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
