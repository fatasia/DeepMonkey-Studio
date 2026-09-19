import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { createBounceScratch, diffuseBounce, type BounceSurface } from "./lightmapIndirect";
import type { BakeLightState } from "./modelOptimizer";

const light: BakeLightState = { id: "sun", name: "sun", type: "directional", enabled: true, color: "#ffffff", intensity: 1,
  direction: [1, -1, 0], position: [0, 0, 0], range: 100 };
function scene(color: number[], blocked = false, emission = [0, 0, 0]) {
  const canopy = new THREE.PlaneGeometry(20, 20).rotateX(Math.PI / 2).translate(0, 1, 0).toNonIndexed();
  const positions = Array.from(canopy.getAttribute("position").array);
  const surface = { diffuse: new THREE.Vector3().fromArray(color), emission: new THREE.Vector3().fromArray(emission), doubleSided: false };
  const surfaces: BounceSurface[] = [surface, surface];
  if (blocked) {
    const wall = new THREE.PlaneGeometry(40, 40).rotateY(Math.PI / 2).translate(5, 0, 0).toNonIndexed();
    positions.push(...wall.getAttribute("position").array);
    const black = { diffuse: new THREE.Vector3(), emission: new THREE.Vector3(), doubleSided: true };
    surfaces.push(black, black);wall.dispose();
  }
  const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  canopy.dispose();return { bvh: new MeshBVH(geometry, { targetLeafSize: 1 }), geometry, surfaces, epsilon: 1e-5 };
}
function sample(value: ReturnType<typeof scene>, lights = [light]) {
  const output = new THREE.Vector3();
  diffuseBounce(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 4, value, lights, output, createBounceScratch());
  value.geometry.dispose();return output;
}
describe("single-bounce diffuse transport", () => {
  it("decorrelates adjacent texels without biasing half-hemisphere emitter energy", () => {
    const geometry = new THREE.PlaneGeometry(20000, 20000).rotateY(Math.PI / 2).translate(.001, 0, 0).toNonIndexed();
    const emitter = { diffuse: new THREE.Vector3(), emission: new THREE.Vector3(1, 1, 1), doubleSided: true };
    const value = { bvh: new MeshBVH(geometry), surfaces: [emitter, emitter], epsilon: 1e-7 };
    const energy: number[] = [];
    for (let index = 0; index < 128; index++) {
      const output = new THREE.Vector3();
      diffuseBounce(new THREE.Vector3(0, index * .0137, 0), new THREE.Vector3(0, 1, 0), 64, value, [], output, createBounceScratch());
      energy.push(output.x);
    }
    expect(new Set(energy).size).toBeGreaterThan(1);
    expect(Math.abs(energy.reduce((sum, sample) => sum + sample, 0) / energy.length - .5)).toBeLessThan(.01);
    geometry.dispose();
  });
  it("keeps high-quality integration deterministic and energy normalized", () => {
    const value = scene([0, 0, 0], false, [.2, .4, .8]);
    value.geometry.scale(100, 1, 100);value.bvh.refit();
    const first = new THREE.Vector3(), second = new THREE.Vector3();
    for (const output of [first, second]) diffuseBounce(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 64, value, [], output, createBounceScratch());
    expect(first.toArray()).toEqual(second.toArray());
    expect(first.x).toBeCloseTo(.2, 12);expect(first.y).toBeCloseTo(.4, 12);expect(first.z).toBeCloseTo(.8, 12);
    value.geometry.dispose();
  });
  it("preserves neutral energy and follows actual reflector albedo", () => {
    const white = sample(scene([.5, .5, .5]));
    expect(white.x).toBeCloseTo(Math.SQRT1_2 * .5, 5);expect(white.y).toBe(white.x);expect(white.z).toBe(white.x);
    const red = sample(scene([.8, .1, .05]));
    expect(red.x / red.y).toBeCloseTo(8);expect(red.y / red.z).toBeCloseTo(2);
    expect(sample(scene([0, 0, 0])).length()).toBe(0);
  });
  it("tests visibility from the bounce surface to the actual light", () => {
    expect(sample(scene([1, 1, 1], true)).length()).toBe(0);
    const masked = scene([1, 1, 1], true);
    masked.surfaces[2]!.sample = masked.surfaces[3]!.sample = () => 0;
    expect(sample(masked).x).toBeCloseTo(Math.SQRT1_2, 5);
  });
  it("continues through cutouts to the actual emitting surface behind them", () => {
    const masked = scene([1, 1, 1]);masked.surfaces[0]!.sample = masked.surfaces[1]!.sample = () => 0;
    const behind = new THREE.PlaneGeometry(40, 40).rotateX(Math.PI / 2).translate(0, 2, 0).toNonIndexed();
    const geometry = new THREE.BufferGeometry().setAttribute("position",new THREE.Float32BufferAttribute([
      ...masked.geometry.getAttribute("position").array,...behind.getAttribute("position").array],3));
    masked.geometry.dispose();behind.dispose();masked.geometry = geometry;masked.bvh = new MeshBVH(geometry,{targetLeafSize:1});
    const emitter = { diffuse: new THREE.Vector3(), emission: new THREE.Vector3(.2,.1,.05),doubleSided:false };
    masked.surfaces.push(emitter,emitter);expect(sample(masked,[]).toArray()).toEqual([.2,.1,.05]);
  });
  it("transports source emissive energy without inventing ambient bounce", () => {
    expect(sample(scene([1, 1, 1]), []).length()).toBe(0);
    expect(sample(scene([0, 0, 0], false, [.1, .2, .3]), []).toArray()).toEqual([.1, .2, .3]);
  });
  it("rejects back-side reflectors unless explicitly double sided", () => {
    const value = scene([1, 1, 1]);value.geometry.scale(-1, 1, 1);value.bvh.refit();
    expect(sample(value).length()).toBe(0);
  });
});
