import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRobotMesh } from "./urdfMeshLoader";
import { RobotResourceScope } from "./urdfPackageResources";

afterEach(() => vi.unstubAllGlobals());
const asciiStl = "solid tri\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid tri";

describe("URDF custom mesh adapters", () => {
  it("loads real STL geometry from package bytes using the URDF material", async () => {
    const scope = new RobotResourceScope(new Map([["mesh.stl", new TextEncoder().encode(asciiStl)]])), material = new THREE.MeshStandardMaterial();
    const mesh = await loadRobotMesh("__robot_package__/mesh.stl", new THREE.LoadingManager(), material, scope) as THREE.Mesh;
    expect(mesh.geometry.getAttribute("position").count).toBe(3); expect(mesh.material).toBe(material); scope.dispose();
  });
  it("loads OBJ geometry and explicitly rejects unhandled MTL dependencies", async () => {
    const source = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", material = new THREE.MeshStandardMaterial();
    const scope = new RobotResourceScope(new Map([["mesh.obj", new TextEncoder().encode(source)], ["mtl.obj", new TextEncoder().encode("mtllib material.mtl\n" + source)]]));
    const object = await loadRobotMesh("__robot_package__/mesh.obj", new THREE.LoadingManager(), material, scope);
    expect((object.children[0] as THREE.Mesh).material).toBe(material);
    await expect(loadRobotMesh("__robot_package__/mtl.obj", new THREE.LoadingManager(), material, scope)).rejects.toThrow("MTL"); scope.dispose();
  });
  it("parses actual glTF with a package-only external buffer and no network fallback", async () => {
    vi.stubGlobal("ProgressEvent", class ProgressEvent extends Event { loaded = 0; total = 0; });
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const json = { asset: { version: "2.0" }, buffers: [{ uri: "mesh.bin", byteLength: positions.byteLength }], bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
    const scope = new RobotResourceScope(new Map([["mesh.gltf", new TextEncoder().encode(JSON.stringify(json))], ["mesh.bin", new Uint8Array(positions.buffer)]]));
    const manager = new THREE.LoadingManager(); manager.setURLModifier(scope.resolve);
    const object = await loadRobotMesh("__robot_package__/mesh.gltf", manager, new THREE.MeshStandardMaterial(), scope);
    expect((object.children[0] as THREE.Mesh).geometry.getAttribute("position").count).toBe(3); scope.dispose();
  });
  it("rejects unknown mesh types and missing package members", async () => {
    const scope = new RobotResourceScope(new Map([["mesh.fbx", new Uint8Array([1])]]));
    await expect(loadRobotMesh("__robot_package__/mesh.fbx", new THREE.LoadingManager(), new THREE.MeshStandardMaterial(), scope)).rejects.toThrow("暂不支持");
    await expect(loadRobotMesh("__robot_package__/missing.stl", new THREE.LoadingManager(), new THREE.MeshStandardMaterial(), scope)).rejects.toThrow("缺少"); scope.dispose();
  });
  it.each(['<!DOCTYPE COLLADA SYSTEM "file:///secret">', '<!ENTITY data SYSTEM "https://example.com/secret">', '<! DOCTYPE COLLADA []>'])("rejects DAE entity declarations before invoking XML parsing: %s", declaration => {
    const parse = vi.fn(); vi.stubGlobal("DOMParser", class { parseFromString = parse; });
    const scope = new RobotResourceScope(new Map([["mesh.dae", new TextEncoder().encode(`${declaration}<COLLADA/>`)]]));
    return expect(loadRobotMesh("__robot_package__/mesh.dae", new THREE.LoadingManager(), new THREE.MeshStandardMaterial(), scope))
      .rejects.toThrow("不支持外部实体").then(() => { expect(parse).not.toHaveBeenCalled(); scope.dispose(); });
  });
});
