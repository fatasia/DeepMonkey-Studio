import { createHash } from "node:crypto";

export const FIXTURE_ID = "factory-instances/cubes-v2";

export function createDeepBevyFixture(instanceCount = 256) {
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 1 || instanceCount > 65_536) {
    throw new RangeError("instanceCount must be within 1..65536");
  }
  const geometry = cubeGeometry(0.08);
  const side = Math.ceil(Math.sqrt(instanceCount));
  const offset = (side - 1) * 0.055;
  const instances = Array.from({ length: instanceCount }, (_, index) => ({
    id: `cube-${index}`, geometry: geometry.id, material: "benchmark-blue",
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
      (index % side) * 0.11 - offset, ((index * 17) % 7) * 0.007, Math.floor(index / side) * 0.11 - offset, 1],
  }));
  return { schema: "deep-engine.render-packet", version: 1, geometries: [geometry],
    materials: [{ id: "benchmark-blue", baseColor: [0.24, 0.52, 0.9], metallic: 0.15, roughness: 0.42 }],
    instances, textures: [] };
}

export function fixtureDescriptor(packet) {
  const value = { id: FIXTURE_ID, instanceCount: packet.instances.length,
    geometryCount: packet.geometries.length, materialCount: packet.materials.length,
    triangles: packet.instances.length * packet.geometries[0].indices.length / 3,
    packetSha256: createHash("sha256").update(JSON.stringify(packet)).digest("hex") };
  return Object.freeze(value);
}

function cubeGeometry(size) {
  const h = size / 2;
  const vertices = [], indices = [];
  const faces = [
    [[0, 0, -1], [[-h, -h, -h], [-h, h, -h], [h, h, -h], [h, -h, -h]]],
    [[0, 0, 1], [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]]],
    [[0, -1, 0], [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]]],
    [[0, 1, 0], [[-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h]]],
    [[1, 0, 0], [[h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]]],
    [[-1, 0, 0], [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]]],
  ];
  for (const [normal, positions] of faces) {
    const base = vertices.length / 6;
    for (const position of positions) vertices.push(...position, ...normal);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { id: "benchmark-cube", revision: 1, vertices, indices };
}

