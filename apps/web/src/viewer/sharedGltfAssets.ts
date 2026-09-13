import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

type AssetResource = THREE.BufferGeometry | THREE.Texture;
interface Entry { promise: Promise<GLTF>; resources: Set<AssetResource>; users: number; pending: number; }
interface Pool { entries: Map<string, Entry>; closed: boolean; }
const pools = new WeakMap<object, Pool>();
const sharedResources = new WeakSet<AssetResource>();
const releases = new WeakMap<THREE.Object3D, () => void>();

export function sharedGltfLoadState(owner: object, url: string, version = ""): "miss" | "pending" | "ready" {
  const entry = pools.get(owner)?.entries.get(JSON.stringify([url, version]));
  return entry ? entry.users > 0 ? "ready" : "pending" : "miss";
}

/** 每个查看器只解析一次同版本 URL；实例树、材质、骨骼独立，几何及原始纹理共用。 */
export async function loadSharedGltf(owner: object, loader: { loadAsync: (url: string) => Promise<GLTF> }, url: string, version = ""): Promise<GLTF> {
  let pool = pools.get(owner);
  if (!pool) { pool = { entries: new Map(), closed: false }; pools.set(owner, pool); }
  if (pool.closed) throw new Error("查看器已关闭");
  const key = JSON.stringify([url, version]);
  let entry = pool.entries.get(key);
  if (!entry) {
    entry = { resources: new Set(), users: 0, pending: 0, promise: undefined! };
    const created = entry;
    entry.promise = loader.loadAsync(url).then(gltf => {
      gltf.scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) created.resources.add(mesh.geometry);
        for (const material of materials(mesh)) for (const texture of materialTextures(material)) created.resources.add(texture);
      });
      created.resources.forEach(resource => sharedResources.add(resource));
      return gltf;
    });
    pool.entries.set(key, entry);
  }
  const current = entry;
  const currentPool = pool;
  current.pending += 1;
  try {
    const source = await current.promise;
    if (currentPool.closed) throw new Error("查看器已关闭");
    const scene = cloneSkeleton(source.scene) as THREE.Group;
    const copies = new Map<THREE.Material, THREE.Material>();
    scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.material) return;
      const cloned = materials(mesh).map(material => {
        let copy = copies.get(material);
        if (!copy) { copy = material.clone(); copies.set(material, copy); }
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!;
    });
    current.users += 1;
    releases.set(scene, () => { current.users -= 1; releaseUnused(currentPool, key, current); });
    return { ...source, scene, scenes: [scene] };
  } finally {
    current.pending -= 1;
    releaseUnused(currentPool, key, current);
  }
}

function releaseUnused(pool: Pool, url: string, entry: Entry): void {
  if (entry.users || entry.pending) return;
  if (pool.entries.get(url) === entry) pool.entries.delete(url);
  entry.resources.forEach(resource => { sharedResources.delete(resource); resource.dispose(); });
  entry.resources.clear();
  // 模板材质从未挂入场景，最后一个实例归还后一起释放。
  void entry.promise.then(gltf => {
    const disposed = new Set<THREE.Material>();
    gltf.scene.traverse(object => materials(object as THREE.Mesh).forEach(material => {
      if (!disposed.has(material)) { disposed.add(material); material.dispose(); }
    }));
  }).catch(() => undefined);
}

export function isSharedGltfResource(resource: AssetResource): boolean { return sharedResources.has(resource); }

/** 在遍历释放材质/几何之后调用，保证其它实例仍使用的 GPU 资源不会提前销毁。 */
export function releaseSharedGltfObject(object: THREE.Object3D): void {
  object.traverse(child => {
    const release = releases.get(child);
    if (!release) return;
    releases.delete(child);
    release();
  });
}

export function closeSharedGltfPool(owner: object): void {
  const pool = pools.get(owner);
  if (!pool) return;
  pool.closed = true;
  for (const [url, entry] of pool.entries) releaseUnused(pool, url, entry);
}

/** 可信脚本获得可变 Three 对象前写时复制，避免改一台设备影响同素材其它实例。 */
export function detachSharedGltfResources(object: THREE.Object3D): void {
  const geometryCopies = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  const textureCopies = new Map<THREE.Texture, THREE.Texture>();
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry && isSharedGltfResource(mesh.geometry)) {
      let copy = geometryCopies.get(mesh.geometry);
      if (!copy) { copy = mesh.geometry.clone(); geometryCopies.set(mesh.geometry, copy); }
      mesh.geometry = copy;
    }
    for (const material of materials(mesh)) for (const [key, value] of Object.entries(material)) {
      if (!(value instanceof THREE.Texture) || !isSharedGltfResource(value)) continue;
      let copy = textureCopies.get(value);
      if (!copy) {
        copy = value.clone();
        // Texture.clone 仍共享 Source 和 mipmap 字节；可信脚本可以直接改像素，必须一并隔离。
        copy.source = new THREE.Source(cloneTextureData(value.source.data));
        copy.source.dataReady = value.source.dataReady;
        copy.mipmaps = cloneTextureData(value.mipmaps) as THREE.Texture["mipmaps"];
        copy.needsUpdate = true;
        textureCopies.set(value, copy);
      }
      (material as unknown as Record<string, unknown>)[key] = copy;
    }
  });
}

export function materialTextures(material: THREE.Material): THREE.Texture[] {
  return Object.values(material).filter((value): value is THREE.Texture => value instanceof THREE.Texture);
}

function materials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
}

function cloneTextureData(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return value instanceof DataView
    ? new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    : (value as unknown as { slice: () => unknown }).slice();
  if (Array.isArray(value)) return value.map(cloneTextureData);
  if (!value || typeof value !== "object") return value;
  const image = value as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  const drawable = (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap)
    || (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement)
    || (typeof OffscreenCanvas !== "undefined" && value instanceof OffscreenCanvas)
    || (typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement);
  if (drawable) {
    const width = image.naturalWidth || image.width || 1, height = image.naturalHeight || image.height || 1;
    const canvas = typeof document !== "undefined" ? document.createElement("canvas")
      : typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : undefined;
    if (!canvas) throw new Error("无法创建独立纹理画布");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context || !("drawImage" in context)) throw new Error("无法创建独立纹理画布");
    context.drawImage(value as CanvasImageSource, 0, 0);
    return canvas;
  }
  if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneTextureData(child)]));
  }
  return value;
}
