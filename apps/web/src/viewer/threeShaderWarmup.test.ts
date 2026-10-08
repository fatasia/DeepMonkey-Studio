import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { collectPostPassMaterials, warmThreeSceneResources, warmThreeShaderPrograms } from "./threeShaderWarmup";

describe("Three shader warmup lifecycle", () => {
  it("warms shared source textures once, preserves pixels and admits a later texture revision", async () => {
    const image = { data: new Uint8Array([255, 64, 32, 255]), width: 1, height: 1 };
    const map = new THREE.DataTexture(image.data, image.width, image.height); map.needsUpdate = true;
    const scene = new THREE.Scene(); scene.background = map;
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map, emissiveMap: map })));
    const properties = new Map<THREE.Texture, { __version?: number }>();
    const renderer = { properties: { get: (value: THREE.Texture) => {
      if (!properties.has(value)) properties.set(value, {}); return properties.get(value)!;
    } }, initTexture: vi.fn((value: THREE.Texture) => { properties.get(value)!.__version = value.version; }) };
    await warmThreeSceneResources(renderer as unknown as THREE.WebGLRenderer, scene);
    await warmThreeSceneResources(renderer as unknown as THREE.WebGLRenderer, scene);
    expect(renderer.initTexture).toHaveBeenCalledOnce(); expect(map.image.data).toBe(image.data);
    map.needsUpdate = true;
    await warmThreeSceneResources(renderer as unknown as THREE.WebGLRenderer, scene);
    expect(renderer.initTexture).toHaveBeenCalledTimes(2);
    await warmThreeSceneResources(renderer as unknown as THREE.WebGLRenderer, scene, () => false);
    expect(renderer.initTexture).toHaveBeenCalledTimes(2);
  });

  it("computes original Three skin bounds and stops before uploads when cancelled between slices", async () => {
    const skin = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const positions = skin.geometry.getAttribute("position");
    skin.geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(positions.count * 4), 4));
    const weights = new Float32Array(positions.count * 4);
    for (let i = 0; i < positions.count; i++) weights[i * 4] = 1;
    skin.geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
    const bone = new THREE.Bone(); skin.add(bone); skin.bind(new THREE.Skeleton([bone]));
    const reference = skin.clone(), cancelledSkin = skin.clone();
    reference.computeBoundingBox(); reference.computeBoundingSphere();
    const box = reference.boundingBox.clone(), sphere = reference.boundingSphere.clone();
    const scene = new THREE.Scene(); scene.add(skin);
    const renderer = { properties: { get: () => ({}) }, initTexture: vi.fn() };
    await warmThreeSceneResources(renderer as unknown as THREE.WebGLRenderer, scene);
    expect(skin.boundingBox).toEqual(box); expect(skin.boundingSphere).toEqual(sphere);
    scene.remove(skin); scene.add(cancelledSkin);
    let active = true;
    vi.spyOn(cancelledSkin, "computeBoundingBox").mockImplementation(function (this: THREE.SkinnedMesh) {
      THREE.SkinnedMesh.prototype.computeBoundingBox.call(this); active = false;
    });
    await warmThreeSceneResources(renderer as unknown as THREE.WebGLRenderer, scene, () => active);
    expect(cancelledSkin.boundingBox).toEqual(box); expect(cancelledSkin.boundingSphere).toBeNull();
    expect(renderer.initTexture).not.toHaveBeenCalled();
  });
  it("refreshes bone world matrices when the pose changes between warmup slices", async () => {
    const geometry = new THREE.BoxGeometry(), count = geometry.getAttribute("position").count;
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) weights[i * 4] = 1;
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
    const skin = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial()), bone = new THREE.Bone();
    skin.add(bone); skin.bind(new THREE.Skeleton([bone]));
    const scene = new THREE.Scene(); scene.add(skin);
    vi.spyOn(skin, "computeBoundingBox").mockImplementation(function (this: THREE.SkinnedMesh) {
      THREE.SkinnedMesh.prototype.computeBoundingBox.call(this); bone.position.x = 20;
    });
    const renderer = { properties: { get: () => ({}) }, initTexture: vi.fn() };
    await warmThreeSceneResources(renderer as unknown as THREE.WebGLRenderer, scene);
    const warmed = skin.boundingSphere.clone();
    skin.computeBoundingSphere();
    expect(warmed).toEqual(skin.boundingSphere);
    expect(warmed.center.x).toBeGreaterThan(19);
  });
  it("warms only enabled pass materials and direct material arrays", () => {
    const active = new THREE.ShaderMaterial(), blur = new THREE.ShaderMaterial(), inactive = new THREE.ShaderMaterial();
    expect(collectPostPassMaterials([{ enabled: true, material: active, blur: [blur, active], nested: { material: inactive } },
      { enabled: false, material: inactive }] as unknown as { enabled: boolean }[])).toEqual([active, blur]);
  });
  it("waits for parallel linking and initializes a shared program once while restoring render target", async () => {
    const material = new THREE.ShaderMaterial(), scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), [material, material]));
    let finish!: () => void;
    const getUniforms = vi.fn(), target = {}, previous = {};
    let currentTarget = previous;
    const renderer = { getRenderTarget: () => currentTarget, setRenderTarget: vi.fn(next => { currentTarget = next; }),
      properties: { get: () => ({ currentProgram: { getUniforms } }) },
      compileAsync: vi.fn(() => { expect(currentTarget).toBe(target); return new Promise<void>(resolve => { finish = resolve; }); }) };
    const pending = warmThreeShaderPrograms(renderer as unknown as THREE.WebGLRenderer, scene,
      new THREE.Camera(), () => true, target as THREE.WebGLRenderTarget);
    expect(currentTarget).toBe(previous); expect(getUniforms).not.toHaveBeenCalled();
    finish(); await pending; expect(getUniforms).toHaveBeenCalledOnce();
  });
  it("ignores destroyed materials and cancellation after linking", async () => {
    const material = new THREE.ShaderMaterial(), scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), material));
    const getUniforms = vi.fn(), renderer = { getRenderTarget: () => null, setRenderTarget: vi.fn(),
      properties: { get: () => ({ currentProgram: { getUniforms } }) }, compileAsync: vi.fn(async () => {}) };
    await warmThreeShaderPrograms(renderer as unknown as THREE.WebGLRenderer, scene, new THREE.Camera(), () => false);
    expect(getUniforms).not.toHaveBeenCalled();
    renderer.properties.get = () => ({}) as ReturnType<typeof renderer.properties.get>;
    await warmThreeShaderPrograms(renderer as unknown as THREE.WebGLRenderer, scene, new THREE.Camera());
    expect(getUniforms).not.toHaveBeenCalled();
  });
});
