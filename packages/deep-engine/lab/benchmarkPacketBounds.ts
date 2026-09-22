import * as THREE from "three/webgpu";
import type { RenderPacket } from "../src/renderPacketTypes.js";

export function benchmarkPacketSphere(packet: RenderPacket): THREE.Sphere {
  const bounds = new Map(packet.geometries.map(geometry => {
    const box = new THREE.Box3();
    for (const index of geometry.indices) box.expandByPoint(new THREE.Vector3().fromArray(geometry.vertices, index * 6));
    return [geometry.id, box] as const;
  }));
  const world = new THREE.Box3();
  for (const instance of packet.instances) {
    const box = bounds.get(instance.geometry);
    if (!box) throw new Error(`Benchmark instance ${instance.id} has no geometry.`);
    world.union(box.clone().applyMatrix4(new THREE.Matrix4().fromArray(Array.from(instance.transform))));
  }
  const sphere = world.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) throw new Error("Benchmark needs finite nonempty scene bounds.");
  return sphere;
}
