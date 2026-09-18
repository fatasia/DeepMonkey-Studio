/** Generate a real static box runtime, then rebase its root transforms and camera with fresh hashes. */
import { writeFile } from "node:fs/promises";
import { compileSceneRuntimePackage } from "../apps/web/src/delivery/compileSceneRuntimePackage.ts";
import { runtimeContentSha256, runtimePackageSha256, parseDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";

const at = "2026-09-15T00:00:00Z", offset = 1e9;
const scene = { schemaVersion: 1 as const, id: "coordinate-frame-gpu", projectId: "fixture", name: "Coordinate frame GPU box",
  models: [], primitives: [{ modelId: "box", name: "Box", kind: "box" as const, color: "#60a5fa", visible: true, opacity: 1,
    transform: { position: { x: offset, y: offset, z: offset }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }], measurements: [],
  camera: { mode: "orbit" as const, position: { x: offset + 3, y: offset + 2, z: offset + 5 }, target: { x: offset, y: offset, z: offset } },
  createdAt: at, updatedAt: at };
const compiled = await compileSceneRuntimePackage(scene, { packageId: "scene.coordinate-frame.gpu", packageVersion: "1.0.0",
  loadModel: async () => { throw new Error("Fixture contains no model assets"); } });
for (const [name, shift] of [["a", 0], ["b", 1000]] as const) {
  const runtime = JSON.parse(compiled.packageJson);
  const camera = runtime.payloads[runtime.entrypoints.camera];
  if (camera.schemaVersion !== 2 || !camera.coordinateFrame) throw new Error("Expected compiler camera schema 2");
  camera.coordinateFrame.origin.x += shift;
  camera.position[0] -= shift; camera.target[0] -= shift;
  const packet = runtime.payloads[runtime.entrypoints.renderPacket];
  if (!packet.instances.length) throw new Error("Expected a nonempty packet");
  for (const instance of packet.instances) instance.transform[12] -= shift;
  for (const resource of runtime.resources) {
    if (resource.id === runtime.entrypoints.camera || resource.id === runtime.entrypoints.renderPacket) {
      resource.contentHash.value = runtimeContentSha256(runtime.payloads[resource.id]);
    }
  }
  runtime.packageHash.value = runtimePackageSha256(runtime);
  const json = JSON.stringify(runtime);
  const checked = parseDeepRuntimePackage(json); if (!checked.valid) throw new Error(JSON.stringify(checked.issues));
  await writeFile(new URL(`../packages/deep-engine-native/tests/fixtures/runtime-package-coordinate-origin-${name}.json`, import.meta.url), json);
  console.log(JSON.stringify({ fixture: name, origin: camera.coordinateFrame.origin, packageHash: runtime.packageHash.value }));
}
