import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeletonHierarchy } from "three/addons/utils/SkeletonUtils.js";
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from "three-mesh-bvh";
import { ThreeProjectionBridge } from "../threeBridge/ThreeProjectionBridge.js";
import type { ProjectionResult } from "../threeBridge/types.js";

function bridge(): ThreeProjectionBridge {
  return new ThreeProjectionBridge({
    hooks: {
      objectBeforeRender: THREE.Object3D.prototype.onBeforeRender,
      objectAfterRender: THREE.Object3D.prototype.onAfterRender,
      objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow,
      objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
      materialBeforeRender: THREE.Material.prototype.onBeforeRender,
      materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
      materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
    },
  });
}

function standardMesh(): THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> {
  return new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ metalness: 0.15, roughness: 0.65 }),
  );
}

function project(
  target: ThreeProjectionBridge,
  root: THREE.Object3D,
): Extract<ProjectionResult, { ok: true }> {
  root.updateWorldMatrix(true, true);
  const result = target.project(root, { cameraLayerMask: 1 });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}

function expectUnsupported(
  result: ProjectionResult,
  feature: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a structured incompatibility result.");
  expect(result.issues).toEqual([
    expect.objectContaining({
      code: "unsupported",
      objectId: expect.stringMatching(/^object-/),
      path: "root",
      feature,
    }),
  ]);
}

async function parseBoxGlb(): Promise<THREE.Group> {
  const bytes = await readFile(new URL("../../lab/assets/Box.glb", import.meta.url));
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return await new Promise<THREE.Group>((resolve, reject) => {
    new GLTFLoader().parse(data, "", (gltf) => resolve(gltf.scene), reject);
  });
}

async function dependencyVersion(name: "three" | "three-mesh-bvh"): Promise<string> {
  const json: unknown = JSON.parse(
    await readFile(new URL(`../../node_modules/${name}/package.json`, import.meta.url), "utf8"),
  );
  if (!json || typeof json !== "object" || !("version" in json)) {
    throw new Error(`Missing ${name} package version.`);
  }
  const version = (json as { readonly version: unknown }).version;
  if (typeof version !== "string") throw new Error(`Invalid ${name} package version.`);
  return version;
}

describe("real Three library and plugin compatibility gate", () => {
  it("pins the exact dependency versions covered by this gate", async () => {
    await expect(dependencyVersion("three")).resolves.toBe("0.185.1");
    await expect(dependencyVersion("three-mesh-bvh")).resolves.toBe("0.9.14");
  });

  it("keeps three-mesh-bvh queries attached to the same author geometry and mesh", () => {
    const author = standardMesh();
    author.geometry.computeBoundsTree = computeBoundsTree;
    author.geometry.disposeBoundsTree = disposeBoundsTree;
    author.raycast = acceleratedRaycast;
    author.geometry.computeBoundsTree();
    author.updateWorldMatrix(true, true);

    const geometry = author.geometry;
    const raycast = author.raycast;
    const boundsTree = author.geometry.boundsTree;
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 3),
      new THREE.Vector3(0, 0, -1),
    );
    raycaster.firstHitOnly = true;
    const before = raycaster.intersectObject(author, false);

    expect(project(bridge(), author).packet.instances).toHaveLength(1);
    const after = raycaster.intersectObject(author, false);

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(before[0]!.object).toBe(author);
    expect(after[0]!.object).toBe(author);
    expect(author.geometry).toBe(geometry);
    expect(author.geometry.boundsTree).toBe(boundsTree);
    expect(author.raycast).toBe(raycast);
  });

  it("keeps real DataTexture and BVH identities while Deep owns projected RGBA8 pixels", () => {
    const author = standardMesh();
    const pixels = new Uint8Array([220, 120, 40, 255]);
    const map = new THREE.DataTexture(pixels, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    map.colorSpace = THREE.SRGBColorSpace; map.needsUpdate = true; author.material.map = map;
    author.geometry.computeBoundsTree = computeBoundsTree; author.geometry.computeBoundsTree();
    const geometry = author.geometry, material = author.material, boundsTree = author.geometry.boundsTree;
    const first = project(bridge(), author), texture = first.packet.textures![0]!;

    expect(texture.semantic).toBe("baseColor"); expect(texture.data).toEqual(pixels); expect(texture.data).not.toBe(pixels);
    expect(author.geometry).toBe(geometry); expect(author.material).toBe(material); expect(author.material.map).toBe(map);
    expect(author.geometry.boundsTree).toBe(boundsTree); expect(map.image.data).toBe(pixels);
  });

  it("lets one AnimationMixer, closure, and event listener continue across projections", () => {
    const author = standardMesh();
    const target = bridge();
    const clip = new THREE.AnimationClip("move", 1, [
      new THREE.NumberKeyframeTrack(".position[x]", [0, 1], [0, 4]),
    ]);
    const mixer = new THREE.AnimationMixer(author);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    const finished: THREE.AnimationAction[] = [];
    mixer.addEventListener("finished", (event) => finished.push(event.action));
    const captured = author;
    const scriptClosure = () => { captured.position.y += 2; };
    action.play();

    mixer.update(0.25);
    const first = project(target, author);
    scriptClosure();
    mixer.update(0.75);
    const second = project(target, author);

    expect(first.packet.instances[0]!.transform[12]).toBeCloseTo(1);
    expect(second.packet.instances[0]!.transform[12]).toBeCloseTo(4);
    expect(second.packet.instances[0]!.transform[13]).toBeCloseTo(2);
    expect(mixer.getRoot()).toBe(author);
    expect(captured).toBe(author);
    expect(finished).toEqual([action]);
  });

  it("projects a real GLTFLoader.parse result without replacing loaded identities", async () => {
    const root = await parseBoxGlb();
    const author = root.getObjectByProperty("isMesh", true) as THREE.Mesh;
    const geometry = author.geometry;
    const material = author.material;
    const parent = author.parent;

    const result = project(bridge(), root);

    expect(result.packet.instances).toHaveLength(1);
    expect(result.packet.geometries[0]!.indices).toHaveLength(36);
    expect(root.getObjectByProperty("isMesh", true)).toBe(author);
    expect(author.geometry).toBe(geometry);
    expect(author.material).toBe(material);
    expect(author.parent).toBe(parent);
  });

  it("projects a SkeletonUtils clone while preserving its documented shared resources", () => {
    const original = new THREE.Group();
    const sourceMesh = standardMesh();
    original.add(sourceMesh);
    const cloned = cloneSkeletonHierarchy(original);
    const clonedMesh = cloned.children[0] as THREE.Mesh;
    const target = bridge();
    const first = project(target, original);
    expect(first.acknowledge()).toBe(true);

    const second = project(target, cloned);

    expect(cloned).not.toBe(original);
    expect(clonedMesh).not.toBe(sourceMesh);
    expect(clonedMesh.geometry).toBe(sourceMesh.geometry);
    expect(clonedMesh.material).toBe(sourceMesh.material);
    expect(second.update).toBe("instances");
    expect(second.packet.instances[0]!.id).not.toBe(first.packet.instances[0]!.id);
  });

  it("reports onBeforeCompile as structured unsupported instead of compatibility", () => {
    const author = standardMesh();
    author.material.onBeforeCompile = () => undefined;
    author.updateWorldMatrix(true, true);

    expectUnsupported(
      bridge().project(author, { cameraLayerMask: 1 }),
      "material render hooks",
    );
  });

  it("reports object render hooks as structured unsupported instead of compatibility", () => {
    const author = standardMesh();
    author.onBeforeRender = () => undefined;
    author.updateWorldMatrix(true, true);

    expectUnsupported(
      bridge().project(author, { cameraLayerMask: 1 }),
      "object render hooks",
    );
  });
});
