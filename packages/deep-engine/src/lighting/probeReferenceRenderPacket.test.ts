import { describe, expect, it } from "vitest";
import { buildReferenceRoomScene, referenceSceneDiagonal } from "./probeReferenceScene.js";
import { buildReferenceRenderPacket, referenceBoxVertices } from "./probeReferenceRenderPacket.js";
import { buildRenderPacketRayScene, RENDER_PACKET_GI_RAY_MASK } from "../rayTracing/renderPacketRayScene.js";
import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";
import { traceTlasClosest } from "../rayTracing/tlas.js";
import { evaluateProbeRadianceEngineParity } from "./probeReferenceIntegrator.js";
import type { ProbeVector3 } from "./probeClipmapPlan.js";

// T02 GPU 联测桥测试：参考场景 → RenderPacket 的忠实性（几何、材质、探针值对拍）。
const scene = buildReferenceRoomScene();
const packet = buildReferenceRenderPacket(scene);

describe("reference box tessellation", () => {
  it("produces 36 axis-aligned outward vertices inside the box bounds", () => {
    for (const box of scene.boxes) {
      const vertices = referenceBoxVertices(box);
      expect(vertices.length).toBe(36 * 6);
      for (let vertex = 0; vertex < 36; vertex++) {
        const base = vertex * 6;
        for (let axis = 0; axis < 3; axis++) {
          // RenderPacket 顶点坐标是 f32（参考场景 f64 边界可能差 ~1e-8，如 0.2）。
          expect(vertices[base + axis]!).toBeGreaterThanOrEqual(box.min[axis]! - 1e-6);
          expect(vertices[base + axis]!).toBeLessThanOrEqual(box.max[axis]! + 1e-6);
        }
        const normal = [vertices[base + 3]!, vertices[base + 4]!, vertices[base + 5]!];
        expect(Math.hypot(...normal)).toBeCloseTo(1, 6);
      }
    }
  });

  it("builds the packet with 12 geometries, 2 materials, 12 identity instances", () => {
    expect(packet.geometries).toHaveLength(scene.boxes.length);
    expect(packet.materials).toHaveLength(2);
    expect(packet.instances).toHaveLength(scene.boxes.length);
    // identity：对角线 0/5/10/15 为 1，其余为 0。
    expect(packet.instances.every(instance => instance.transform.every((value, axis) =>
      value === (axis % 5 === 0 ? 1 : 0)))).toBe(true);
    // box 0 是地板材质，其余墙材质；albedo 与场景常量一致。
    const byId = new Map(packet.materials.map(material => [material.id, material]));
    expect(byId.get("reference-floor")!.baseColor).toEqual([0.7, 0.68, 0.66]);
    expect(byId.get("reference-wall")!.baseColor).toEqual([0.5, 0.5, 0.52]);
  });
});

describe("packet-path probe parity vs reference integrator", () => {
  const rayScene = buildRenderPacketRayScene(packet);
  const albedoOf = new Map(rayScene.materials.map(binding => {
    const material = packet.materials.find(candidate => candidate.id === binding.material.id)!;
    return [binding.instanceId, material.baseColor] as const;
  }));
  const tMax = referenceSceneDiagonal(scene);

  // 与 GPU 联测同一公式（参考尺度：无 /π、命中点无阴影射线）。
  const packetProbeValue = (position: ProbeVector3, count: number): ProbeVector3 => {
    const sum: number[] = [0, 0, 0];
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const [dx, dy, dz] = probeOcclusionDirection(ordinal, count);
      const hit = traceTlasClosest(rayScene.tlas, { ox: position[0], oy: position[1], oz: position[2],
        dx, dy, dz, tMax }, RENDER_PACKET_GI_RAY_MASK);
      if (!hit) { sum[0] += scene.ambient[0]; sum[1] += scene.ambient[1]; sum[2] += scene.ambient[2]; continue; }
      const albedo = albedoOf.get(hit.instanceId)!;
      const geometry = packet.geometries.find(candidate => {
        const instance = packet.instances.find(entry => entry.id === hit.instanceId)!;
        return candidate.id === instance.geometry; })!;
      const i0 = geometry.indices[hit.primitiveIndex * 3]! * 6;
      const i1 = geometry.indices[hit.primitiveIndex * 3 + 1]! * 6;
      const i2 = geometry.indices[hit.primitiveIndex * 3 + 2]! * 6;
      const ax = geometry.vertices[i0]!, ay = geometry.vertices[i0 + 1]!, az = geometry.vertices[i0 + 2]!;
      const bx = geometry.vertices[i1]!, by = geometry.vertices[i1 + 1]!, bz = geometry.vertices[i1 + 2]!;
      const cx = geometry.vertices[i2]!, cy = geometry.vertices[i2 + 1]!, cz = geometry.vertices[i2 + 2]!;
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const length = Math.hypot(nx, ny, nz);
      nx /= length; ny /= length; nz /= length;
      if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
      const nDotL = Math.max(nx * scene.light.surfaceToLightWorld[0]! + ny * scene.light.surfaceToLightWorld[1]!
        + nz * scene.light.surfaceToLightWorld[2]!, 0);
      sum[0] += albedo[0] * nDotL; sum[1] += albedo[1] * nDotL; sum[2] += albedo[2] * nDotL;
    }
    return [sum[0] / count, sum[1] / count, sum[2] / count];
  };

  it("agrees with the slab-based reference integrator on stable probes (fib16)", () => {
    const positions: ProbeVector3[] = [[2, 1, 3], [6, 1, 1], [2, 2, 4], [6.5, 2, 5], [1, 1, 1]];
    for (const position of positions) {
      const expected = evaluateProbeRadianceEngineParity(scene, position, 16);
      const actual = packetProbeValue(position, 16);
      actual.forEach((value, axis) => expect(Math.abs(value - expected.irradiance[axis]!)).toBeLessThan(1e-9));
    }
  });

  it("keeps miss directions through the skylight hole and seals the room elsewhere", () => {
    // 天窗正下方向上逃逸（miss → ambient）；室内其他方向全部命中。
    const sky: ProbeVector3 = [2.25, 1, 3];
    const hit = traceTlasClosest(rayScene.tlas, { ox: sky[0], oy: sky[1], oz: sky[2],
      dx: 0.02, dy: 1, dz: 0, tMax }, RENDER_PACKET_GI_RAY_MASK);
    expect(hit).toBeUndefined();
    const wall = traceTlasClosest(rayScene.tlas, { ox: sky[0], oy: sky[1], oz: sky[2],
      dx: 0, dy: -1, dz: 0, tMax }, RENDER_PACKET_GI_RAY_MASK);
    expect(wall).toBeDefined();
  });
});
