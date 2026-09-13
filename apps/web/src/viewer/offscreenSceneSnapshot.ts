import * as THREE from "three";
import type { OffscreenSceneInventory } from "./offscreenSceneCompatibility";
import type { OffscreenImage, OffscreenJson, OffscreenSnapshot } from "./offscreenRenderProtocol";
import type { JSONMeta } from "three/src/core/Object3D.js";

export function offscreenSerializationMeta(inventory: OffscreenSceneInventory) {
  const meta: JSONMeta = { geometries: {}, materials: {}, textures: {}, images: {}, shapes: {}, skeletons: {}, animations: {}, nodes: {} };
  for (const texture of inventory.textures.values()) meta.images[texture.source.uuid] = { uuid: texture.source.uuid, url: "" };
  return meta;
}

export async function snapshotOffscreenScene(scene: THREE.Scene, inventory: OffscreenSceneInventory, signal: AbortSignal): Promise<OffscreenSnapshot> {
  const images: OffscreenImage[] = [];
  try {
    // 序列化必须先于任何 await:场景可能在让出事件循环的间隙变化,
    // 先同步锁住与体检清单一致的对象图,再异步生成纹理位图。
    const meta = offscreenSerializationMeta(inventory) as JSONMeta;
    // 序列化显式支持的节点，不执行隐藏专用对象的 toJSON，也不触碰原场景父子关系。
    const serializeNode = (source: THREE.Object3D): OffscreenJson => {
      const children = source.children;
      const json = source.toJSON.call({ ...source, children: [] }, meta).object as unknown as OffscreenJson;
      delete json.userData; delete json.animations;
      json.children = children.filter(child => !inventory.pruned.has(child.uuid)).map(serializeNode);
      return json;
    };
    const root = serializeNode(scene);
    for (const texture of inventory.textures.values()) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const source = texture.image as TexImageSource & { data?: THREE.TypedArray; width: number; height: number };
      if (source.data) images.push({ uuid: texture.uuid, pixels: { data: source.data.slice() as THREE.TypedArray, width: source.width, height: source.height } });
      else images.push({ uuid: texture.uuid, bitmap: await createImageBitmap(source as ImageBitmapSource, {
        imageOrientation: texture.flipY ? "flipY" : "none", premultiplyAlpha: texture.premultiplyAlpha ? "premultiply" : "none", colorSpaceConversion: "none",
      }) });
    }
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    // 合同校验:序列化引入的纹理必须都在体检清单内,否则 Worker 端会拿到没有图像的纹理。
    const extra = Object.keys(meta.textures).filter(uuid => !inventory.textures.has(uuid));
    if (extra.length) {
      let owner = "未知对象";
      let ownerPruned = false;
      let ownerUuid = "";
      scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        const assigned = mesh.material ? Array.isArray(mesh.material) ? mesh.material : [mesh.material] : [];
        for (const material of assigned) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture && extra.includes(value.uuid)) {
            owner = `${object.type}:${object.name || object.uuid}`;
            ownerPruned = inventory.pruned.has(object.uuid);
            ownerUuid = object.uuid;
          }
        }
      });
      throw new Error(`快照序列化引入未体检纹理 ${extra[0]},属主=${owner} uuid=${ownerUuid} pruned=${ownerPruned} prunedCount=${inventory.pruned.size}`);
    }
    const json: OffscreenJson = { metadata: { version: 4.7, type: "Object", generator: "Studio Offscreen" }, object: root };
    for (const [key, value] of Object.entries(meta)) if (key !== "images") json[key] = Object.values(value).map(item => {
      const copy = { ...item as Record<string, unknown> } as OffscreenJson; delete copy.userData; delete copy.metadata;
      if (key === "textures") copy.image = copy.uuid;
      return copy;
    });
    return { json, images };
  } catch (error) { closeOffscreenImages(images); throw error; }
}

export function closeOffscreenImages(images: OffscreenImage[]): void { for (const image of images) image.bitmap?.close(); }
export function offscreenSnapshotTransfers(snapshot: OffscreenSnapshot): Transferable[] {
  const result: Transferable[] = [];
  for (const image of snapshot.images) {
    if (image.bitmap) result.push(image.bitmap as unknown as Transferable);
    else if (image.pixels) result.push(image.pixels.data.buffer as ArrayBuffer);
  }
  return result;
}

export function parseOffscreenSnapshot(snapshot: OffscreenSnapshot): THREE.Scene {
  // 先做合同校验:纹理表与图像表必须一一对应,缺失时给出可操作原因而不是 three 内部的 undefined.data。
  const textureIds: string[] = (snapshot.json.textures as Array<{ uuid: string }> | undefined)?.map(texture => texture.uuid) ?? [];
  const imageIds = new Set(snapshot.images.map(image => image.uuid));
  const missing = textureIds.filter(uuid => !imageIds.has(uuid));
  if (missing.length) {
    throw new Error(`后台快照缺少 ${missing.length}/${textureIds.length} 张纹理图像; 缺失=${missing.join(",")} 全部纹理=[${textureIds.join(",")}] 已有图像=[${[...imageIds].join(",")}]`);
  }
  const loader = new THREE.ObjectLoader();
  loader.parseImages = () => Object.fromEntries(snapshot.images.map(image => [image.uuid, new THREE.Source(image.bitmap ?? image.pixels)]));
  return loader.parse(snapshot.json) as THREE.Scene;
}
