import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ViewerEngine } from "./ViewerEngine";
import { updateSceneLightDirectionLine } from "./sceneLightDirectionLine";

function fixture() {
  const engine = Object.create(ViewerEngine.prototype);
  const light = new THREE.DirectionalLight(); light.position.set(.1, 2, 3);
  const target = new THREE.Object3D(); target.position.set(4, .2, 6);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial());
  const camera = new THREE.PerspectiveCamera(); camera.position.set(10, 10, 10);
  Object.assign(engine, { camera, sceneLights: new Map([["light", light]]), sceneLightTargets: new Map([["light", target]]),
    sceneLightProxies: new Map([["light", { position: new THREE.Group(), target: new THREE.Group(), line }]]) });
  return { light, target, line, camera, update: () => engine.updateSceneLightProxies() };
}

describe("light direction proxy incremental updates", () => {
  it("initializes coincident endpoints once without invalid distances or bounds", () => {
    const { line } = fixture();
    const origin = new THREE.Vector3();
    updateSceneLightDirectionLine(line, origin, origin);
    const distance = line.geometry.getAttribute("lineDistance") as THREE.BufferAttribute;
    expect(Array.from(distance.array)).toEqual([0, 0]);
    expect(line.geometry.boundingSphere?.radius).toBe(0);
    const version = distance.version;
    updateSceneLightDirectionLine(line, origin, origin);
    expect(distance.version).toBe(version);
  });

  it("does not re-upload or replace geometry attributes across 1000 idle or camera-only frames", () => {
    const { line, update, camera } = fixture(); update();
    const positions = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    const distances = line.geometry.getAttribute("lineDistance") as THREE.BufferAttribute;
    const version = positions.version, distanceVersion = distances.version;
    for (let frame = 0; frame < 1000; frame++) { camera.position.x += .01; update(); }
    expect(positions.version).toBe(version);
    expect(line.geometry.getAttribute("lineDistance")).toBe(distances);
    expect(distances.version).toBe(distanceVersion);
  });

  it("updates both endpoints, dash distances and bounds when a light or target moves", () => {
    const { line, light, target, update } = fixture(); update();
    const positions = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    const distances = line.geometry.getAttribute("lineDistance") as THREE.BufferAttribute;
    const initialVersion = positions.version;
    light.position.set(-10, 0, 0); target.position.set(10, 0, 0); update();
    expect(positions.version).toBe(initialVersion + 1);
    expect(Array.from(positions.array)).toEqual([-10, 0, 0, 10, 0, 0]);
    expect(line.geometry.getAttribute("lineDistance")).toBe(distances);
    expect(Array.from(distances.array)).toEqual([0, 20]);
    expect(line.geometry.boundingSphere?.radius).toBe(10);
    target.position.x = 0; update();
    expect(Array.from(distances.array)).toEqual([0, 10]);
  });
});
