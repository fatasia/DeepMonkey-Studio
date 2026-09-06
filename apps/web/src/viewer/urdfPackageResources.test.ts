import JSZip from "jszip";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRobotPackage, RobotResourceScope, safeRobotPath, type RobotFiles } from "./urdfPackageResources";
import { robotDefinition } from "./robotPoseTestFixture";
import { prepareRobotGltf } from "./urdfGltfResources";

afterEach(() => vi.restoreAllMocks());
const source = new TextEncoder().encode('<robot name="fixture"><link name="base"/></robot>');
function definitionFor(files: RobotFiles) {
  const definition = robotDefinition();
  definition.resources = [...files].map(([path, data]) => ({ path, size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") }));
  return definition;
}

describe("closed URDF package resource boundary", () => {
  it("reads a source URDF and verifies its exact bytes", async () => {
    const files: RobotFiles = new Map([["robot.urdf", source]]);
    expect(await readRobotPackage(source.buffer, definitionFor(files), false)).toEqual(files);
  });
  it("reads ZIP resources including nested meshes with their manifest evidence", async () => {
    const files: RobotFiles = new Map([["robot.urdf", source], ["meshes/link.stl", new Uint8Array([1, 2, 3])]]), zip = new JSZip();
    for (const [path, data] of files) zip.file(path, data);
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    expect(await readRobotPackage(bytes, definitionFor(files), true)).toEqual(files);
  });
  it.each(["sha256", "size"])("rejects changed resource %s", async field => {
    const definition = definitionFor(new Map([["robot.urdf", source]]));
    Object.assign(definition.resources[0]!, { [field]: field === "sha256" ? "0".repeat(64) : 1 });
    await expect(readRobotPackage(source.buffer, definition, false)).rejects.toThrow("校验失败");
  });
  it("rejects unlisted files rather than exposing them to secondary loaders", async () => {
    const bytes = await new JSZip().file("robot.urdf", source).file("extra.bin", "hidden").generateAsync({ type: "arraybuffer" });
    await expect(readRobotPackage(bytes, definitionFor(new Map([["robot.urdf", source]])), true)).rejects.toThrow("清单");
  });
  it("rejects original traversal paths before JSZip can sanitize them", async () => {
    const bytes = await new JSZip().file("../robot.urdf", source).generateAsync({ type: "arraybuffer" });
    await expect(readRobotPackage(bytes, definitionFor(new Map([["robot.urdf", source]])), true)).rejects.toThrow("路径");
  });
  it("rejects case-colliding original entries", async () => {
    const bytes = await new JSZip().file("robot.urdf", source).file("ROBOT.urdf", source).generateAsync({ type: "arraybuffer" });
    await expect(readRobotPackage(bytes, definitionFor(new Map([["robot.urdf", source]])), true)).rejects.toThrow("重复");
  });
  it("bounds actual decompression by the independently declared resource size", async () => {
    const bytes = await new JSZip().file("robot.urdf", source).generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    const definition = definitionFor(new Map([["robot.urdf", source]])); definition.resources[0]!.size = 2;
    await expect(readRobotPackage(bytes, definition, true)).rejects.toThrow("实际解压");
  });
  it("honors cancellation before parsing and during package processing", async () => {
    const files: RobotFiles = new Map([["robot.urdf", source]]), controller = new AbortController(); controller.abort();
    await expect(readRobotPackage(source.buffer, definitionFor(files), false, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const running = new AbortController(), bytes = await new JSZip().file("robot.urdf", source).generateAsync({ type: "arraybuffer" });
    const pending = readRobotPackage(bytes, definitionFor(files), true, running.signal); queueMicrotask(() => running.abort());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each(["https://example.com/a.png", "file:///secret", "blob:unowned", "data:image/png;base64,eA==", "__robot_package__/../../private.bin", "__robot_package__/%2e%2e/private.bin"])("never resolves foreign URL %s", url => {
    const scope = new RobotResourceScope(new Map([["robot.urdf", source]]));
    expect(() => scope.resolve(url)).toThrow();
  });
  it("owns only generated URLs, reuses a path and revokes all on completion", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL"), scope = new RobotResourceScope(new Map([["robot.urdf", source]]));
    const url = scope.resolve("__robot_package__/robot.urdf");
    expect(scope.resolve("__robot_package__/robot.urdf")).toBe(url); expect(scope.resolve(url)).toBe(url);
    scope.dispose(); expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
    expect(() => scope.resolve(url)).toThrow();
  });
  it("allows a relative sibling only while it remains inside the package", () => {
    expect(safeRobotPath("meshes/../textures/a.png")).toBe("textures/a.png");
    expect(() => safeRobotPath("../textures/a.png")).toThrow();
  });
});

describe("URDF glTF closed resource preparation", () => {
  it("registers external buffers and bufferView images to owned URLs", () => {
    const data = new Uint8Array([1, 2, 3, 4]), scope = new RobotResourceScope(new Map([["mesh/data.bin", data]]));
    const json = { asset: { version: "2.0" }, buffers: [{ uri: "data.bin", byteLength: 4 }], bufferViews: [{ buffer: 0, byteLength: 4 }], images: [{ bufferView: 0, mimeType: "image/png" }] };
    const result = JSON.parse(prepareRobotGltf(new TextEncoder().encode(JSON.stringify(json)), "mesh/arm.gltf", scope));
    expect(result.images[0].bufferView).toBeUndefined();
    expect(scope.resolve(result.images[0].uri)).toBe(result.images[0].uri);
    expect(scope.resolve(result.buffers[0].uri)).toBe(result.buffers[0].uri);
    scope.dispose();
  });
  it.each(["https://example.com/data.bin", "../../private.bin", "blob:someone-else"])("rejects mesh dependency %s without fetching", uri => {
    const scope = new RobotResourceScope(new Map()), json = { asset: { version: "2.0" }, buffers: [{ uri, byteLength: 3 }] };
    expect(() => prepareRobotGltf(new TextEncoder().encode(JSON.stringify(json)), "mesh/arm.gltf", scope)).toThrow();
  });
  it("rejects an out-of-bounds embedded image", () => {
    const scope = new RobotResourceScope(new Map([["data.bin", new Uint8Array([1])]]));
    const json = { asset: { version: "2.0" }, buffers: [{ uri: "data.bin", byteLength: 1 }], bufferViews: [{ buffer: 0, byteLength: 40 }], images: [{ bufferView: 0 }] };
    expect(() => prepareRobotGltf(new TextEncoder().encode(JSON.stringify(json)), "arm.gltf", scope)).toThrow("范围"); scope.dispose();
  });
});
