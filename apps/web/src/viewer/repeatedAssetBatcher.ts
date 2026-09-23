import * as THREE from "three";
import type { LoadedSceneModel } from "./viewerTypes";

interface Batch { mesh: THREE.InstancedMesh; sources: THREE.Mesh[]; }
/** 每网格分组键缓存：矩阵与标志未变化时复用上一帧的 key 字符串，避免每帧两次模板字符串分配。 */
interface MeshGroupKeyCache {
  material: THREE.Material;
  geometryUuid: string;
  castShadow: number;
  receiveShadow: number;
  frustumCulled: number;
  layersMask: number;
  materialId: number;
  matrixWorld: THREE.Matrix4;
  key: string;
}
const DEFAULT_BEFORE_RENDER = THREE.Object3D.prototype.onBeforeRender;
const DEFAULT_BEFORE_COMPILE = THREE.Material.prototype.onBeforeCompile;
const SPATIAL_CELL_SIZE = 32;

/** 只替换一帧的绘制表示。作者对象始终保留身份/层级，拾取、绑定、导出仍使用原对象。 */
export class RepeatedAssetBatcher {
  private readonly root = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly hidden: THREE.Mesh[] = [];
  private readonly inverseRoot = new THREE.Matrix4();
  private readonly matrix = new THREE.Matrix4();
  private readonly previous = new THREE.Matrix4();
  private readonly materialIds = new Map<string, number>();
  private meshKeys = new WeakMap<THREE.Mesh, MeshGroupKeyCache>();
  private nextMaterialId = 0;
  private sourceCount = 0;
  private batchCount = 0;
  private enabled = true;

  constructor(private readonly parent: THREE.Object3D) {
    this.root.name = "helper:repeated-assets";
    this.root.userData.effectHelper = true;
    this.root.visible = false;
  }

  begin(models: Iterable<LoadedSceneModel>, excluded?: ReadonlySet<THREE.Object3D>): void {
    this.end();
    if (!this.enabled) return;
    this.parent.updateWorldMatrix(true, true);
    this.inverseRoot.copy(this.parent.matrixWorld).invert();
    const groups = new Map<string, THREE.Mesh[]>();
    const signatures = new Map<THREE.Material, number | undefined>();
    for (const model of models) {
      if (!model.visible || !model.object.visible) continue;
      model.object.traverseVisible(object => {
        const mesh = object as THREE.Mesh;
        if (!eligibleMesh(mesh) || excluded?.has(mesh)) return;
        const material = mesh.material as THREE.Material;
        let materialId = signatures.get(material);
        if (!signatures.has(material)) {
          const signature = materialSignature(material);
          if (signature !== undefined) {
            materialId = this.materialIds.get(signature);
            if (materialId === undefined) { materialId = ++this.nextMaterialId; this.materialIds.set(signature, materialId); }
          }
          signatures.set(material, materialId);
        }
        if (materialId === undefined || !(mesh.matrixWorld.determinant() > 0)) return;
        this.matrix.multiplyMatrices(this.inverseRoot, mesh.matrixWorld);
        if (hasShear(this.matrix)) return;
        // 空间分桶保留粗粒度裁剪，远处设备不会因一个巨大批次全部进入绘制。
        // 键派生按网格缓存：材质/几何/标志/世界矩阵均未变化时直接复用上一帧 key，跳过字符串构造。
        const cache = this.meshKeys.get(mesh);
        if (cache && cache.material === material && cache.materialId === materialId
          && cache.geometryUuid === mesh.geometry.uuid
          && cache.castShadow === Number(mesh.castShadow) && cache.receiveShadow === Number(mesh.receiveShadow)
          && cache.frustumCulled === Number(mesh.frustumCulled) && cache.layersMask === mesh.layers.mask
          && cache.matrixWorld.equals(mesh.matrixWorld)) {
          const group = groups.get(cache.key);
          if (group) group.push(mesh); else groups.set(cache.key, [mesh]);
          return;
        }
        const e = mesh.matrixWorld.elements;
        const cell = `${Math.floor(e[12]! / SPATIAL_CELL_SIZE)},${Math.floor(e[13]! / SPATIAL_CELL_SIZE)},${Math.floor(e[14]! / SPATIAL_CELL_SIZE)}`;
        const key = `${mesh.geometry.uuid}:${materialId}:${Number(mesh.castShadow)}:${Number(mesh.receiveShadow)}:${Number(mesh.frustumCulled)}:${mesh.layers.mask}:${cell}`;
        const group = groups.get(key);
        if (group) group.push(mesh); else groups.set(key, [mesh]);
        this.meshKeys.set(mesh, {
          material, geometryUuid: mesh.geometry.uuid,
          castShadow: Number(mesh.castShadow), receiveShadow: Number(mesh.receiveShadow),
          frustumCulled: Number(mesh.frustumCulled), layersMask: mesh.layers.mask,
          materialId, matrixWorld: mesh.matrixWorld.clone(), key,
        });
      });
    }
    const used = new Set<string>();
    this.sourceCount = 0; this.batchCount = 0;
    for (const [key, sources] of groups) {
      if (sources.length < 4) continue;
      used.add(key);
      let batch = this.batches.get(key);
      if (!batch || batch.mesh.instanceMatrix.count < sources.length) {
        if (batch) this.release(batch);
        const first = sources[0]!;
        const mesh = new THREE.InstancedMesh(first.geometry, first.material, Math.max(4, 2 ** Math.ceil(Math.log2(sources.length))));
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = first.castShadow; mesh.receiveShadow = first.receiveShadow;
        mesh.frustumCulled = first.frustumCulled;
        mesh.layers.mask = first.layers.mask;
        mesh.userData.effectHelper = true;
        mesh.matrixAutoUpdate = false;
        this.root.add(mesh);
        batch = { mesh, sources: [] }; this.batches.set(key, batch);
      }
      let changed = batch.mesh.count !== sources.length;
      batch.mesh.count = sources.length;
      batch.mesh.material = sources[0]!.material;
      sources.forEach((source, index) => {
        this.matrix.multiplyMatrices(this.inverseRoot, source.matrixWorld);
        batch!.mesh.getMatrixAt(index, this.previous);
        if (!this.previous.equals(this.matrix)) { batch!.mesh.setMatrixAt(index, this.matrix); changed = true; }
        source.visible = false; this.hidden.push(source);
      });
      batch.sources = sources;
      if (changed) {
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.mesh.computeBoundingBox(); batch.mesh.computeBoundingSphere();
      }
      this.sourceCount += sources.length; this.batchCount += 1;
    }
    for (const [key, batch] of this.batches) if (!used.has(key)) { this.release(batch); this.batches.delete(key); }
    this.root.visible = this.batchCount > 0;
    if (this.batchCount > 0) this.parent.add(this.root);
    // 外观组合不无限保留；当前帧的数值分组完成后可重新编号。
    if (this.materialIds.size > 2_048) { this.clear(); this.materialIds.clear(); this.nextMaterialId = 0; }  }

  end(): void {
    for (const source of this.hidden) source.visible = true;
    this.hidden.length = 0; this.root.visible = false;
    this.root.removeFromParent();
  }

  statistics(): { sources: number; batches: number; avoidedDraws: number } {
    return { sources: this.sourceCount, batches: this.batchCount, avoidedDraws: this.sourceCount - this.batchCount };
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  clear(): void {
    this.end();
    for (const batch of this.batches.values()) this.release(batch);
    this.batches.clear(); this.sourceCount = 0; this.batchCount = 0;
    // materialIds 重编号会使缓存 key 中的数值失效，分组键缓存整体重建。
    this.meshKeys = new WeakMap();
  }

  dispose(): void { this.clear(); this.root.removeFromParent(); this.materialIds.clear(); }

  private release(batch: Batch): void {
    batch.mesh.removeFromParent(); batch.mesh.dispose();
  }
}

function eligibleMesh(mesh: THREE.Mesh): boolean {
  for (let ancestor = mesh.parent; ancestor; ancestor = ancestor.parent) if (ancestor.renderOrder !== 0) return false;
  return mesh.isMesh === true && mesh.type === "Mesh" && !Array.isArray(mesh.material)
    && mesh.children.length === 0 && mesh.renderOrder === 0 && mesh.geometry?.getAttribute("position") !== undefined
    && Object.keys(mesh.geometry.morphAttributes).length === 0 && !mesh.morphTargetInfluences
    && !mesh.customDepthMaterial && !mesh.customDistanceMaterial && mesh.onBeforeRender === DEFAULT_BEFORE_RENDER
    && mesh.onAfterRender === THREE.Object3D.prototype.onAfterRender
    && mesh.onBeforeShadow === THREE.Object3D.prototype.onBeforeShadow
    && mesh.onAfterShadow === THREE.Object3D.prototype.onAfterShadow
    && !mesh.userData.effectHelper && !mesh.userData.layerDeleted;
}

function hasShear(matrix: THREE.Matrix4): boolean {
  const e = matrix.elements;
  const x = e[0]! ** 2 + e[1]! ** 2 + e[2]! ** 2;
  const y = e[4]! ** 2 + e[5]! ** 2 + e[6]! ** 2;
  const z = e[8]! ** 2 + e[9]! ** 2 + e[10]! ** 2;
  return Math.abs(e[0]! * e[4]! + e[1]! * e[5]! + e[2]! * e[6]!) > 1e-6 * Math.sqrt(x * y)
    || Math.abs(e[0]! * e[8]! + e[1]! * e[9]! + e[2]! * e[10]!) > 1e-6 * Math.sqrt(x * z)
    || Math.abs(e[4]! * e[8]! + e[5]! * e[9]! + e[6]! * e[10]!) > 1e-6 * Math.sqrt(y * z);
}

function materialSignature(material: THREE.Material): string | undefined {
  if (material.type !== "MeshStandardMaterial" && material.type !== "MeshBasicMaterial") return undefined;
  if (!material.visible || material.transparent || material.opacity < 1 || !material.depthTest || !material.depthWrite || material.clippingPlanes?.length
    || material.onBeforeCompile !== DEFAULT_BEFORE_COMPILE || material.onBeforeRender !== THREE.Material.prototype.onBeforeRender
    || material.userData.studioUvAnimation
    || material.userData.studioShaderEffect || material.userData.studioScreenState) return undefined;
  const values: string[] = [];
  for (const [key, value] of Object.entries(material)) {
    if (["id", "uuid", "name", "version", "userData", "_listeners"].includes(key)) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") values.push(`${key}:${value}`);
    else if (value instanceof THREE.Color) values.push(`${key}:${value.r},${value.g},${value.b}`);
    else if (value instanceof THREE.Vector2) values.push(`${key}:${value.x},${value.y}`);
    else if (value instanceof THREE.Euler) values.push(`${key}:${value.x},${value.y},${value.z},${value.order}`);
    else if (value instanceof THREE.Texture) {
      if ((value as THREE.VideoTexture).isVideoTexture) return undefined;
      values.push(`${key}:${value.uuid}`);
    } else if (key === "defines") values.push(`${key}:${JSON.stringify(value)}`);
  }
  return values.join("|");
}
