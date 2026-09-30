import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const geometry = JSON.parse(await readFile(path.join(root, "packages/deep-engine/fixtures/j3-geometry-depth-v1.json"), "utf8"));
const source = JSON.parse(await readFile(path.join(root, geometry.sourceFixture), "utf8"));
const packet = source.payloads[source.entrypoints.renderPacket];
const sun = { surfaceToLightWorld: [0, .6, .8], radiance: [2.5, 2.4, 2.25], intensity: 1, exposure: 1,
  shadows: false, environment: false, localLights: false, diffuseLights: false };
const apply = (m, v) => Array.from({ length: 4 }, (_, row) => v.reduce((sum, x, column) => sum + m[column * 4 + row] * x, 0));
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const cameras = geometry.cameras.map(camera => {
  const subsets = packet.instances.filter(instance => instance.geometry === "golden-triangle").map(instance => {
    const mesh = packet.geometries.find(mesh => mesh.id === instance.geometry);
    const material = packet.materials.find(material => material.id === instance.material);
    if (mesh.indices.some(index => mesh.vertices.slice(index * 6 + 3, index * 6 + 6).some((value, axis) => value !== [0, 0, 1][axis]))
      || instance.transform[10] <= 0 || [2, 6, 8, 9].some(index => instance.transform[index] !== 0)
      || material.emissiveFactor?.some(value => value !== 0) || !(material.metallic < 1))
      throw Error("Lambert lower bound requires this packet's flat +Z normal, nonmetallic diffuse and no emission");
    const diffuseFloor = material.baseColor.map((value, channel) =>
      (1 - material.metallic) * value / Math.PI * sun.surfaceToLightWorld[2] * sun.radiance[channel]);
    if (diffuseFloor.some(value => !(value > 0))) throw Error("Strict direct-light lower bound must be positive");
    const corners = mesh.indices.slice(0, 3).map(index => {
      const world = apply(instance.transform, [...mesh.vertices.slice(index * 6, index * 6 + 3), 1]);
      const clip = apply(camera.expectedVP, world);
      return [(clip[0] / clip[3] * .5 + .5) * geometry.width, (.5 - clip[1] / clip[3] * .5) * geometry.height];
    });
    const sign = Math.sign(cross(corners[0], corners[1], corners[2])), pixels = [];
    for (let y = 0; y < geometry.height; y++) for (let x = 0; x < geometry.width; x++) {
      const p = [x + .5, y + .5];
      if (corners.every((a, edge) => {
        const b = corners[(edge + 1) % 3];
        return sign * cross(a, b, p) / Math.hypot(b[0] - a[0], b[1] - a[1]) >= 1.5;
      })) pixels.push(y * geometry.width + x);
    }
    return { instanceId: instance.id, materialId: instance.material, diffuseFloor, pixels };
  });
  return { ...camera, subsets };
});
const manifest = { ...geometry, schema: "j3-hdr-flat-normal-v1", cameras,
  sun,
  hdrThresholds: { minPixelsPerSubset: 16, maxChannelError: .002, minPsnr: 60, minSsim: .9999, peak: 1 },
  maskContract: "packet golden-triangle projected by frozen official cameraMath expectedVP; every center >=1.5px inside all edges" };
for (const camera of cameras) for (const subset of camera.subsets)
  if (subset.pixels.length < manifest.hdrThresholds.minPixelsPerSubset) throw Error(`Too few preregistered pixels: ${camera.id}/${subset.instanceId}`);
await writeFile(path.join(root, "packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ packetHash: geometry.packetHash,
  maskCounts: cameras.map(c => ({ camera: c.id, subsets: c.subsets.map(s => s.pixels.length) })),
  fixtureHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") }));
