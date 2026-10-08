import * as THREE from "three";

async function yieldCompilation(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield(): Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  await new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(undefined);
  });
}

/** Warm original resources one at a time; keep their resolution, pixel data and skin math. */
export async function warmThreeSceneResources(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
  current: () => boolean = () => true): Promise<void> {
  if (!current()) return;
  scene.updateMatrixWorld(true);
  const textures = new Set<THREE.Texture>(), skins: THREE.SkinnedMesh[] = [];
  const texture = (value: unknown): void => {
    if (value instanceof THREE.Texture && !value.isRenderTargetTexture && !(value instanceof THREE.VideoTexture)) textures.add(value);
  };
  texture(scene.background); texture(scene.environment);
  scene.traverseVisible(object => {
    if (object instanceof THREE.SkinnedMesh && (object.boundingBox === null || object.boundingSphere === null)) skins.push(object);
    const material = (object as THREE.Mesh).material;
    for (const value of Array.isArray(material) ? material : material ? [material] : []) {
      for (const field of Object.values(value)) texture(field);
      if (value instanceof THREE.ShaderMaterial) for (const uniform of Object.values(value.uniforms)) {
        if (Array.isArray(uniform.value)) uniform.value.forEach(texture); else texture(uniform.value);
      }
    }
  });
  for (const skin of skins) {
    if (!current()) return;
    scene.updateMatrixWorld(true);
    if (skin.boundingBox === null) { skin.computeBoundingBox(); await yieldCompilation(); }
    if (!current()) return;
    scene.updateMatrixWorld(true);
    if (skin.boundingSphere === null) { skin.computeBoundingSphere(); await yieldCompilation(); }
  }
  for (const value of textures) {
    if (!current()) return;
    const properties = renderer.properties.get(value) as { __version?: number };
    if (value.version > 0 && properties.__version !== value.version) {
      renderer.initTexture(value); await yieldCompilation();
    }
  }
}

/** r186 compileAsync waits for linking; first-use uniforms/diagnostics still run synchronously.
 * Initialize one linked program per task so a Composer frame cannot aggregate their stalls. */
export async function warmThreeShaderPrograms(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
  camera: THREE.Camera, current: () => boolean = () => true, target?: THREE.WebGLRenderTarget | null): Promise<void> {
  const previous = renderer.getRenderTarget();
  let compilation: Promise<unknown>;
  try { if (target !== undefined) renderer.setRenderTarget(target); compilation = renderer.compileAsync(scene, camera); }
  finally { renderer.setRenderTarget(previous); }
  await compilation;
  const materials = new Set<THREE.Material>();
  scene.traverse(object => {
    const material = (object as THREE.Mesh).material;
    for (const value of Array.isArray(material) ? material : material ? [material] : []) materials.add(value);
  });
  const programs = new Set<unknown>();
  for (const material of materials) {
    if (!current()) return;
    const properties = renderer.properties.get(material) as { currentProgram?: { getUniforms(): unknown } };
    const program = properties.currentProgram;
    if (program && !programs.has(program)) { program.getUniforms(); programs.add(program); await yieldCompilation(); }
  }
}

/** Three passes own public materials and material arrays; exclude scene/texture graphs. */
export function collectPostPassMaterials(passes: readonly { enabled: boolean }[]): THREE.Material[] {
  const materials = new Set<THREE.Material>();
  for (const pass of passes) {
    if (!pass.enabled) continue;
    for (const value of Object.values(pass as unknown as Record<string, unknown>)) {
      if (value instanceof THREE.Material) materials.add(value);
      else if (Array.isArray(value)) for (const item of value) if (item instanceof THREE.Material) materials.add(item);
    }
  }
  return [...materials];
}
