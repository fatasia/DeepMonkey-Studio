import { describe, expect, it } from "vitest";
import { planCascadedShadows } from "../shadows/cascadedShadowPlanner.js";
import { packGpuLodScene } from "./gpuLodPacking.js";
import { selectGpuLodReference } from "./gpuLodReference.js";
import { shadowLodView } from "./packetShadowLodResources.js";
import { shadowProbePacket, shadowProbePlan } from "../../lab/packetShadowLodProbeScene.js";

const plan = planCascadedShadows({ eye: [0, 0, 0], target: [0, 0, 1], near: 0.1, far: 100,
  verticalFovRadians: Math.PI / 2, aspect: 1 }, [0, -1, 0], { cascadeCount: 3, shadowMapSize: 64, depthPadding: 20 });

describe("shadow LOD view", () => {
  it("calibrates the real GPU fixture to exercise near detail and nonresident middle-level fallback", () => {
    const packet = shadowProbePacket(), caster = packet.instances[0]!, profile = caster.lod!;
    const geometry = packet.geometries.find(value => value.id === caster.geometry)!;
    const radius = Math.max(...Array.from(geometry.indices, index => Math.hypot(
      geometry.vertices[index * 6]!, geometry.vertices[index * 6 + 1]!, geometry.vertices[index * 6 + 2]!)));
    const input = packGpuLodScene([{ sphere: [-0.5, 0, 0, radius], instanceIndex: 0,
      levels: profile.levels.map((level, index) => ({ ...level, triangles: packet.geometries
        .find(value => value.id === level.geometry)!.indices.length / 3, meshletOffset: index, meshletCount: 1 })) }]);
    const fixturePlan = shadowProbePlan();
    const records = fixturePlan.cascades.slice(0, 2).map(cascade => {
      const view = shadowLodView(fixturePlan, cascade);
      return selectGpuLodReference(input, view.camera, view.viewport).records[0]!;
    });
    expect(records.map(record => record.baseLevel)).toEqual([0, 1]);
    expect(records.map(record => record.selectedLevel)).toEqual([0, 2]);
  });
  it("uses light texel density and covers the cascade depth volume independently from color near/far", () => {
    for (const cascade of plan.cascades) {
      const view = shadowLodView(plan, cascade), camera = view.camera;
      expect(camera.projection).toBe("orthographic");
      expect(view.budget).toBeUndefined();
      if (camera.projection !== "orthographic") throw new Error("Expected light camera");
      expect(camera.verticalSize).toBeCloseTo(cascade.texelWorldSize * plan.shadowMapSize);
      expect(view.viewport).toEqual({ width: 64, height: 64 });
      for (const corner of cascade.corners) {
        const depth = corner.reduce((sum, value, index) => sum +
          (value - camera.position[index]!) * camera.forward[index]!, 0);
        expect(depth).toBeGreaterThan(camera.near);
        expect(depth).toBeLessThan(camera.far);
      }
    }
  });

  it("keeps an upstream caster outside the main camera and selects coarser geometry for wider cascades", () => {
    const first = plan.cascades[0]!, position = [first.center[0], first.center[1] + first.radius, first.center[2]] as const;
    const sphere = [...position, 1] as const;
    const levels = [{ minProjectedDiameterPixels: 3, geometricError: 0, triangles: 8, meshletOffset: 0, meshletCount: 1 },
      { minProjectedDiameterPixels: 1, geometricError: 0.5, triangles: 4, meshletOffset: 1, meshletCount: 1, resident: false },
      { minProjectedDiameterPixels: 0, geometricError: 1, triangles: 1, meshletOffset: 2, meshletCount: 1 }];
    const input = packGpuLodScene([{ sphere, levels, instanceIndex: 0 }]);
    const color = selectGpuLodReference(input, { projection: "perspective", position: [0, 0, 0], forward: [0, 0, -1],
      near: 0.1, far: 100, verticalFovRadians: Math.PI / 2 }, { width: 64, height: 64 });
    expect(color.records[0]!.selectedLevel).toBeNull();
    const selected = plan.cascades.map(cascade => {
      const view = shadowLodView(plan, cascade);
      return selectGpuLodReference(input, view.camera, view.viewport).records[0]!.selectedLevel;
    });
    expect(selected).toEqual([0, 2, 2]);
  });
});
