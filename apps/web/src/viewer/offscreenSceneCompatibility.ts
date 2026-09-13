import * as THREE from "three";

const OBJECT_TYPES = new Set(["Scene", "Group", "Object3D", "Mesh", "Line", "LineSegments", "LineLoop", "Points", "Sprite",
  "PerspectiveCamera", "OrthographicCamera", "AmbientLight", "HemisphereLight", "DirectionalLight", "PointLight", "SpotLight"]);
const MATERIAL_TYPES = new Set(["MeshBasicMaterial", "MeshStandardMaterial", "MeshPhysicalMaterial", "MeshPhongMaterial", "MeshLambertMaterial",
  "MeshNormalMaterial", "MeshDepthMaterial", "LineBasicMaterial", "LineDashedMaterial", "PointsMaterial", "SpriteMaterial", "ShadowMaterial"]);
const identities = new WeakMap<object, number>(); let nextIdentity = 0;
function identity(value: object): number { let id = identities.get(value); if (!id) { id = ++nextIdentity; identities.set(value, id); } return id; }
export type OffscreenSceneInventory = ReturnType<typeof inspectOffscreenScene>;

export function inspectOffscreenScene(scene: THREE.Scene) {
  const objects = new Map<string, THREE.Object3D>(); const materials = new Map<string, THREE.Material>();
  const textures = new Map<string, THREE.Texture>(); const geometries = new Map<string, THREE.BufferGeometry>();
  const pruned = new Set<string>(); const signatures: string[] = [];
  let reason = ""; let bytes = 0;
  const texture = (value: THREE.Texture) => {
    if (textures.has(value.uuid)) return;
    textures.set(value.uuid, value);
    if ((value as THREE.VideoTexture).isVideoTexture || (value as THREE.CompressedTexture).isCompressedTexture || value.isRenderTargetTexture
      || value instanceof THREE.CubeTexture || !value.image || value.mipmaps.length || !value.matrixAutoUpdate) reason ||= "当前纹理需要主线程渲染";
    const image = value.image as { width?: number; height?: number } | undefined;
    bytes += (image?.width ?? 0) * (image?.height ?? 0) * 4;
    signatures.push(`t:${value.uuid}:${value.version}:${value.source.version}:${identity(value.source)}:${value.offset.toArray()}:${value.repeat.toArray()}:${value.rotation}:${value.colorSpace}:${value.flipY}`);
  };
  const visit = (object: THREE.Object3D, visible: boolean) => {
    // 标注/告警 Sprite 的画布纹理在运行时重建,属于易变叠加层:不进 Worker 快照与签名,
    // 由主线程按投影位置画在回传位图之上,避免纹理漂移触发反复重启。
    if ((object as THREE.Sprite).isSprite) { pruned.add(object.uuid); return; }
    const mesh = object as THREE.Mesh; const drawn = visible && object.visible;
    const unsupported = !OBJECT_TYPES.has(object.type) || object.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender
      || object.onAfterRender !== THREE.Object3D.prototype.onAfterRender || object.onBeforeShadow !== THREE.Object3D.prototype.onBeforeShadow
      || object.onAfterShadow !== THREE.Object3D.prototype.onAfterShadow || Boolean(mesh.customDepthMaterial || mesh.customDistanceMaterial);
    if (unsupported) { if (drawn) reason ||= "当前对象包含专用渲染逻辑"; pruned.add(object.uuid); return; }
    objects.set(object.uuid, object); signatures.push(`o:${object.uuid}:${object.parent?.uuid ?? ""}`);
    if (mesh.geometry) {
      const geometry = mesh.geometry;
      if (Object.keys(geometry.morphAttributes).length) reason ||= "形变模型使用主线程渲染";
      if (!geometries.has(geometry.uuid)) {
        geometries.set(geometry.uuid, geometry);
        const attributes = [...Object.entries(geometry.attributes), ...(geometry.index ? [["index", geometry.index] as const] : [])];
        const versions = attributes.map(([key, attribute]) => {
          if (!(attribute instanceof THREE.BufferAttribute)) { reason ||= "交错几何使用主线程渲染"; return key; }
          bytes += attribute.array.byteLength;
          return `${key}:${identity(attribute)}:${identity(attribute.array)}:${attribute.version}`;
        });
        signatures.push(`g:${geometry.uuid}:${versions.join(";")}:${JSON.stringify(geometry.drawRange)}:${JSON.stringify(geometry.groups)}`);
      }
      signatures.push(`bind:${object.uuid}:${geometry.uuid}`);
    }
    const assigned = mesh.material ? Array.isArray(mesh.material) ? mesh.material : [mesh.material] : [];
    signatures.push(`m:${assigned.map(material => material.uuid).join(",")}`);
    for (const material of assigned) {
      if (!MATERIAL_TYPES.has(material.type) || material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
        || material.onBeforeRender !== THREE.Material.prototype.onBeforeRender || material.clippingPlanes?.length) reason ||= "当前材质需要主线程渲染";
      materials.set(material.uuid, material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) texture(value);
    }
    const light = object as THREE.SpotLight;
    if (light.isLight) {
      if (light.map) texture(light.map);
      signatures.push(`l:${light.uuid}:${light.color.getHex()}:${light.intensity}:${light.distance}:${light.decay}:${light.angle}:${light.penumbra}:${JSON.stringify(light.shadow?.toJSON())}`);
    }
    for (const child of object.children) visit(child, drawn);
  };
  visit(scene, true);
  if (scene.background instanceof THREE.Texture) texture(scene.background);
  if (scene.environment) texture(scene.environment);
  signatures.push(`scene:${scene.background instanceof THREE.Color ? scene.background.getHex() : scene.background?.uuid}:${scene.environment?.uuid}:${scene.environmentIntensity}:${scene.backgroundIntensity}:${scene.backgroundBlurriness}:${scene.backgroundRotation.toArray()}:${scene.environmentRotation.toArray()}:${JSON.stringify(scene.fog?.toJSON())}`);
  if (objects.size > 10000 || bytes > 128 * 1024 * 1024) reason ||= "当前场景超过后台渲染资源预算";
  return { objects, materials, textures, geometries, pruned, signature: signatures.join("|"), reason, bytes };
}
