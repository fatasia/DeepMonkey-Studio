import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { projectThreeWorldLights } from "./threeWorldLights.js";

function accepted(result: ReturnType<typeof projectThreeWorldLights>) {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.lights;
}

describe("Three world-light adapter", () => {
  it("projects real directional, point and spot lights from updated world matrices", () => {
    const scene = new THREE.Scene(), group = new THREE.Group();
    group.position.set(10, -2, 3); scene.add(group);

    const directional = new THREE.DirectionalLight("#808080", 2.5);
    directional.position.set(4, 6, 8); directional.target.position.set(1, 2, 3);
    group.add(directional, directional.target);
    const point = new THREE.PointLight("#4080ff", 7, 12, 2);
    point.position.set(-1, 4, 2); group.add(point);
    const spot = new THREE.SpotLight("#ff8040", 9, 30, 0.7, 0.35, 2);
    spot.position.set(2, 5, 9); spot.target.position.set(-2, 1, 3);
    group.add(spot, spot.target);
    scene.updateWorldMatrix(true, true);

    const lights = accepted(projectThreeWorldLights(scene, { cameraLayerMask: 1 }));
    expect(lights.directional).toHaveLength(1);
    expect(lights.points).toHaveLength(1);
    expect(lights.spots).toHaveLength(1);
    expect(lights.directional?.[0]?.directionWorld).toEqual([
      -3 / Math.sqrt(50), -4 / Math.sqrt(50), -5 / Math.sqrt(50),
    ]);
    expect(lights.directional?.[0]).toMatchObject({
      color: [directional.color.r, directional.color.g, directional.color.b], intensity: 2.5,
    });
    expect(lights.points?.[0]).toMatchObject({ positionWorld: [9, 2, 5], range: 12, intensity: 7 });
    expect(lights.spots?.[0]).toMatchObject({ positionWorld: [12, 3, 12], range: 30, intensity: 9 });
    expect(lights.spots?.[0]?.directionWorld).toEqual([
      -4 / Math.sqrt(68), -4 / Math.sqrt(68), -6 / Math.sqrt(68),
    ]);
    expect(lights.spots?.[0]?.outerConeCos).toBe(Math.fround(Math.cos(0.7)));
    expect(lights.spots?.[0]?.innerConeCos).toBe(Math.fround(Math.cos(0.7 * 0.65)));
    expect(Object.isFrozen(lights)).toBe(true);
    expect(Object.isFrozen(lights.spots?.[0])).toBe(true);
  });

  it("preserves unlimited range and hard cone edges, retaining optional bounded overrides", () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.PointLight(0xffffff, 1, 0, 2));
    const spot = new THREE.SpotLight(0xffffff, 1, 0, Math.PI / 3, 0, 2);
    scene.add(spot, spot.target); scene.updateWorldMatrix(true, true);

    const missing = projectThreeWorldLights(scene, { cameraLayerMask: 1 });
    expect(missing).toMatchObject({ ok: true, lights: { points: [{ range: 0 }], spots: [{ range: 0 }] } });

    const calls: string[] = [];
    const lights = accepted(projectThreeWorldLights(scene, {
      cameraLayerMask: 1,
      fallbackRange: (_light, path) => { calls.push(path); return path.endsWith("[0]") ? 40 : 60; },
    }));
    expect(lights.points?.[0]?.range).toBe(40);
    expect(lights.spots?.[0]?.range).toBe(60);
    expect(calls).toEqual(["root.children[0]", "root.children[1]"]);
    expect(lights.spots?.[0]?.innerConeCos).toBe(lights.spots?.[0]?.outerConeCos);
  });

  it("maps a shadow-casting Three spot light to a stable Deep atlas identity", () => {
    const scene = new THREE.Scene();
    const spot = new THREE.SpotLight(0xffffff, 5, 20, 0.6, 0.2, 2);
    spot.castShadow = true; scene.add(spot, spot.target); scene.updateWorldMatrix(true, true);

    const lights = accepted(projectThreeWorldLights(scene, { cameraLayerMask: 1 }));
    expect(lights.spots?.[0]?.shadow).toEqual({ key: `three:${spot.uuid}` });

    Object.defineProperty(spot, "uuid", { value: "../unstable/key" });
    const malformed = projectThreeWorldLights(scene, { cameraLayerMask: 1 });
    expect(malformed).toMatchObject({ ok: false });
    if (!malformed.ok) expect(malformed.issues[0]).toMatchObject({ code: "invalid", feature: "light shadow identity" });
  });

  it("rejects unsupported visible light semantics with actionable diagnostics", () => {
    const scene = new THREE.Scene();
    const ambient = new THREE.AmbientLight(), hemisphere = new THREE.HemisphereLight();
    const cookieSpot = new THREE.SpotLight(0xffffff, 1, 5);
    cookieSpot.map = new THREE.Texture();
    const wrongDecay = new THREE.PointLight(0xffffff, 1, 5, 5);
    scene.add(ambient, hemisphere, cookieSpot, cookieSpot.target, wrongDecay);
    scene.updateWorldMatrix(true, true);

    const result = projectThreeWorldLights(scene, { cameraLayerMask: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(issue => [issue.type, issue.code, issue.feature])).toEqual([
      ["AmbientLight", "unsupported", "light type AmbientLight"],
      ["HemisphereLight", "unsupported", "light type HemisphereLight"],
      ["SpotLight", "unsupported", "spot map"],
      ["PointLight", "invalid", "light decay"],
    ]);
    expect(result.issues.every(issue => issue.path.startsWith("root.children["))).toBe(true);
  });

  it("honors inherited visibility and camera layers while never updating author objects", () => {
    const scene = new THREE.Scene(), hidden = new THREE.Group();
    hidden.visible = false; hidden.add(new THREE.AmbientLight()); scene.add(hidden);
    const excluded = new THREE.HemisphereLight(); excluded.layers.set(2); scene.add(excluded);
    const point = new THREE.PointLight(0xffffff, 3, 8, 2); point.layers.set(1); scene.add(point);
    scene.updateWorldMatrix(true, true);
    const updateWorldMatrix = vi.spyOn(scene, "updateWorldMatrix");

    const lights = accepted(projectThreeWorldLights(scene, { cameraLayerMask: 1 << 1 }));
    expect(lights.points).toHaveLength(1);
    expect(updateWorldMatrix).not.toHaveBeenCalled();
  });

  it("rejects a degenerate target, unsupported point shadow and malformed fallback values", () => {
    const scene = new THREE.Scene();
    const directional = new THREE.DirectionalLight();
    directional.position.set(1, 1, 1); directional.target.position.copy(directional.position);
    const shadowed = new THREE.PointLight(0xffffff, 1, 4, 2); shadowed.castShadow = true;
    const unbounded = new THREE.PointLight(0xffffff, 1, 0, 2);
    scene.add(directional, directional.target, shadowed, unbounded); scene.updateWorldMatrix(true, true);

    const result = projectThreeWorldLights(scene, { cameraLayerMask: 1, fallbackRange: Number.NaN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(issue => issue.feature)).toEqual(["light direction", "light shadows", "fallbackRange"]);
  });
});
