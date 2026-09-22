import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyLightIes, applySceneIesProfiles } from "./studioIesAuthorCarriers";

describe("persisted IES author carriers", () => {
  it("projects and clears exact saved profile data without retaining stale state", () => {
    const scene = new THREE.Scene(), spot = new THREE.SpotLight();
    const profile = { profileId: "ies-factory", format: "LM-63-2002" as const, verticalAngles: [0, 90],
      candela: [[1000, 0]], horizontalSymmetry: 1 as const, totalLumens: 1000 };
    applySceneIesProfiles(scene, { enabled: true, intensity: 1, lightProfiles: [profile] });
    applyLightIes(spot, { id: "spot", name: "Spot", type: "spot", enabled: true, color: "#fff", intensity: 1,
      ies: { profileId: "ies-factory", rotationDeg: 45, scaleFactor: .5 } });
    expect(scene.userData.lightProfiles).toEqual([profile]);
    expect(spot.userData.ies).toEqual({ profileId: "ies-factory", rotationDeg: 45, scaleFactor: .5 });
    applySceneIesProfiles(scene, { enabled: true, intensity: 1 });
    applyLightIes(spot, { id: "spot", name: "Spot", type: "spot", enabled: true, color: "#fff", intensity: 1 });
    expect(scene.userData).not.toHaveProperty("lightProfiles");
    expect(spot.userData).not.toHaveProperty("ies");
  });
});
