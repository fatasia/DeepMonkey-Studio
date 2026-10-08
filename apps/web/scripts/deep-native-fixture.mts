import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrimitiveState, SceneSnapshot } from "@bim-studio/contracts";
import { buildDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { fixtureCameraDistance, fixtureObjects } from "../benchmarks/render-engine/src/fixture.ts";
import { compileSceneRenderPacket } from "../src/delivery/compileSceneRenderPacket.ts";
import { compileSceneCamera } from "../src/delivery/compileSceneCamera.ts";
import { compileSceneEnvironment } from "../src/delivery/compileSceneEnvironment.ts";
import { primitiveGroundOffset } from "../src/viewer/primitiveGeometry.ts";

export function nativeFixtureScene(count: number): SceneSnapshot {
  if (![120, 1000].includes(count)) throw new Error("Fixture count must be 120 or 1000.");
  const distance = fixtureCameraDistance(count);
  const primitives: PrimitiveState[] = fixtureObjects(count).map(item => ({
    modelId: `fixture-${item.index}`, name: item.kind, kind: item.kind,
    color: item.color, visible: true, opacity: 1,
    material: { roughness: 0.72, metalness: 0.05 },
    transform: {
      position: { x: item.position[0], y: primitiveGroundOffset(item.kind), z: item.position[2] },
      rotation: { x: 0, y: item.rotationY, z: 0 },
      scale: { x: item.scale[0], y: item.scale[1], z: item.scale[2] },
    },
  }));
  // Author plane is already Y-up, 3x3. Scale it to the benchmark ground.
  primitives.push({ modelId: "fixture-ground", name: "ground", kind: "plane",
    color: "#202a2e", visible: true, opacity: 1, material: { roughness: 0.94, metalness: 0 },
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      scale: { x: distance, y: 1, z: distance } } });
  return {
    schemaVersion: 1, id: `render-bench-${count}`, projectId: "render-bench", name: `Native fixture ${count}`,
    camera: { mode: "orbit", position: { x: distance, y: distance * 0.72, z: distance },
      target: { x: 0, y: 1.8, z: 0 } },
    environment: { gridVisible: false, skybox: "none", backgroundColor: "#11191d" },
    lighting: { enabled: true, intensity: 1, shadowsEnabled: true, reflectionsEnabled: false,
      globalIlluminationEnabled: false, lights: [
        { id: "sun", name: "sun", type: "directional", enabled: true, color: "#ffffff",
          intensity: 2.2, position: { x: 18, y: 28, z: 12 }, target: { x: 0, y: 0, z: 0 }, castShadow: true },
        { id: "hemisphere", name: "hemisphere", type: "hemisphere", enabled: true,
          color: "#bddcff", groundColor: "#3b4249", intensity: 0.35, position: { x: 0, y: 1, z: 0 } },
      ] },
    primitives, models: [], measurements: [], createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z",
  };
}

export async function buildNativeFixture(count: number) {
  const scene = nativeFixtureScene(count);
  const { packet, sourceBytes } = await compileSceneRenderPacket(scene, {
    loadModel: async () => { throw new Error("Primitive fixture must not load external assets."); },
  });
  // Match the browser's six shared PBR materials and one ground material.
  const shared = new Map<string, typeof packet.materials[number]>();
  const remap = new Map<string, string>();
  for (const material of packet.materials) {
    const { id, ...values } = material;
    const key = JSON.stringify(values);
    if (!shared.has(key)) shared.set(key, material);
    remap.set(id, shared.get(key)!.id);
  }
  const renderPacket = { ...packet, materials: [...shared.values()], instances: packet.instances.map(item => ({
    ...item, material: remap.get(item.material)!, castShadow: item.id !== "fixture-ground",
  })) };
  const camera = { ...compileSceneCamera(scene), verticalFovDegrees: 48, near: 0.1, far: 5000 };
  const environment = compileSceneEnvironment(scene.environment, scene.lighting);
  if (!environment?.lighting || sourceBytes !== 0) throw new Error("Fixture lighting or asset contract failed.");
  const runtimePackage = buildDeepRuntimePackage({ packageId: `bench.native-${count}`, packageVersion: "1.0.0",
    renderPacket: { id: "bench.render-packet", revision: 1, value: renderPacket }, camera,
    environment: { ...environment, lighting: { ...environment.lighting, exposure: 1.05 } },
  });
  const triangles = renderPacket.instances.reduce((sum, item) => sum
    + renderPacket.geometries.find(geometry => geometry.id === item.geometry)!.indices.length / 3, 0);
  return { runtimePackage, scene, manifest: { objectCount: count, instanceCount: renderPacket.instances.length,
    geometries: renderPacket.geometries.length, materials: renderPacket.materials.length, triangles, sourceBytes,
    camera, environment: runtimePackage.payloads["scene.environment"],
    differences: ["Native shadow-map policy and MSAA are runtime defaults; no cross-renderer pixel parity claimed.",
      "Frame interval is host time between wgpu surface.present calls, not compositor completion."] } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = Number(process.argv[2]);
  const output = fileURLToPath(new URL("../../../test-output/deep-native-bench/", import.meta.url));
  const { runtimePackage, scene, manifest } = await buildNativeFixture(count);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `fixture-${count}.runtime-package.json`), JSON.stringify(runtimePackage));
  await writeFile(path.join(output, `fixture-${count}.scene.json`), JSON.stringify(scene, null, 2));
  await writeFile(path.join(output, `fixture-${count}.manifest.json`), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ count, ...manifest }));
}
