import { describe, expect, it } from "vitest";
import type { GeometryResource, PbrMaterial, RenderPacket, RenderInstance } from "../renderPacketTypes.js";
import type { RuntimeSceneCamera } from "../runtimePackage/camera.js";
import { createPathTraceRenderPacketKernel } from "./pathTraceRenderPacketKernel.js";
import { buildPathTraceRenderPacketScene } from "./pathTraceRenderPacketScene.js";
import { adaptPathTraceRenderPacketMaterial } from "./pathTraceRenderPacketMaterial.js";
import { PathTraceCpuRender } from "./pathTraceCpuRender.js";
import { decodeRadianceHdr } from "../textures/radianceHdr.js";
import { RUNTIME_COORDINATE_PROFILE } from "../runtimePackage/coordinates.js";
import { createPathTraceCpuKernel } from "./pathTraceCpuKernel.js";

const geometry: GeometryResource = { id: "triangle", revision: 1,
  vertices: new Float32Array([-1e5, -1e5, 0, 0, 0, 1, 1e5, -1e5, 0, 0, 0, 1, 0, 1e5, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]) };
const material: PbrMaterial = { id: "lambert", baseColor: [0.5, 0.25, 0.75], metallic: 0,
  roughness: 1, ior: 1, doubleSided: true };
const matrix = (z = 0) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1]);
const instance = (id = "surface", materialId = material.id, transform = matrix()): RenderInstance =>
  ({ id, geometry: geometry.id, material: materialId, transform });
const packet = (): RenderPacket => ({ geometries: [geometry], materials: [material], instances: [instance()] });
const camera: RuntimeSceneCamera = { schema: "deep-engine.scene-camera", schemaVersion: 1,
  id: "camera", revision: 1, position: [0, 0, 3], target: [0, 0, 0], verticalFovDegrees: 1, near: 0.1, far: 100 };
const query = { ox: 0, oy: 0, oz: 3, dx: 0, dy: 0, dz: -1, tMax: 20 };

describe("formal RenderPacket path trace subset", () => {
  it("preserves original instance material and nearest transformed surface", () => {
    const bright = { ...material, id: "bright", baseColor: [1, 1, 1] as const };
    const scene = buildPathTraceRenderPacketScene({ ...packet(), materials: [material, bright],
      instances: [instance("far"), instance("near", "bright", matrix(1))] });
    expect(scene.traceSurface(query)).toMatchObject({ t: 2, normal: [0, 0, 1], material: { reflectance: [1, 1, 1] } });
    expect(scene.instanceCount).toBe(2); expect(scene.uniqueBlasCount).toBe(1);
    for (let ray = 0; ray < 32; ray++) expect(scene.traceSurface(query)?.t).toBe(2);
    expect(scene.uniqueBlasCount).toBe(1);
  });
  it("transforms geometric normals by inverse transpose for non-uniform scale/shear", () => {
    const transform = new Float32Array([2, 0, 0.5, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]);
    const hit = buildPathTraceRenderPacketScene({ ...packet(), instances: [instance("shear", material.id, transform)] }).traceSurface(query)!;
    expect(hit.t).toBeCloseTo(3, 12);
    expect(hit.normal[0]).toBeCloseTo(-0.25 / Math.hypot(0.25, 1), 12);
    expect(hit.normal[2]).toBeCloseTo(1 / Math.hypot(0.25, 1), 12);
  });
  it("supports rotation and mirrored static instances", () => {
    const rotation = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
    const rotated = buildPathTraceRenderPacketScene({ ...packet(), instances: [instance("rotated", material.id, rotation)] });
    expect(rotated.traceSurface({ ox: 3, oy: 0, oz: 0, dx: -1, dy: 0, dz: 0, tMax: 10 }))
      .toMatchObject({ t: 3, normal: [1, 0, 0] });
    const mirrored = matrix(); mirrored[0] = -2; mirrored[5] = 3; mirrored[10] = 4;
    expect(buildPathTraceRenderPacketScene({ ...packet(), instances: [instance("mirrored", material.id, mirrored)] }).traceSurface(query)?.t).toBe(3);
  });
  it("keeps the formal RenderPacket contract that rejects empty geometry", () => {
    const empty = { ...geometry, id: "empty", vertices: new Float32Array(), indices: new Uint32Array() };
    expect(() => buildPathTraceRenderPacketScene({ ...packet(), geometries: [empty, geometry], instances: [
      { ...instance("empty-first"), geometry: "empty" }, instance("live"),
      { ...instance("empty-middle"), geometry: "empty" }, instance("far", material.id, matrix(-1)),
    ] })).toThrow(/geometry layout/);
  });
  it("uses the formal camera and production IOR1 PBR through the real session/HDR consumer", () => {
    const kernel = createPathTraceRenderPacketKernel({ width: 1, height: 1, camera, packet: packet(),
      environment: [1, 2, 4], rouletteStart: 64 });
    expect(kernel.profile).toBe("production-opaque-two-sided-pbr-single-and-multiple");
    const render = new PathTraceCpuRender({ width: 1, height: 1, maxSamples: 4096, minSamples: 4096,
      varianceThreshold: .025, maxAccumulationBytes: 24, sampleSeed: 3 });
    render.begin({ sceneRevision: 1, materialHash: "mat", cameraHash: "cam" }, kernel);
    expect(render.advance(4096).converged).toBe(true);
    const image = decodeRadianceHdr(render.exportHdr().bytes);
    // Independent normal-view SG single+C8 integral for IOR1/rough1, scaled by RGB environment.
    const expected = [.5002429849114093, .5004859698228186, 3.0009719396456372];
    for (let c = 0; c < 3; c++) expect(Math.abs(image.data[c]! - expected[c]!)).toBeLessThan(.02);
    expect(render.session.residentBytes).toBe(0);
  });
  it("supports production dielectric, mixed and full-metal PBR without Lambert substitution", () => {
    for (const metallic of [0, .5, 1]) expect(adaptPathTraceRenderPacketMaterial(
      { ...material, metallic, ior: 1.5, roughness: .6 })).toMatchObject({ model: "production-opaque-pbr", metallic });
  });
  it("reuses the same production PBR transport byte for byte as the single-BLAS reference", () => {
    const metal = { ...material, metallic: 1, ior: 1.5, roughness: 0.6 };
    const formal = createPathTraceRenderPacketKernel({ width: 1, height: 1, camera,
      packet: { ...packet(), materials: [metal] }, environment: [1, 1, 1], rouletteStart: 64 });
    const positions = new Float32Array([-1e5, -1e5, 0, 1e5, -1e5, 0, 0, 1e5, 0]);
    const reference = createPathTraceCpuKernel({ width: 1, height: 1,
      camera: { origin: camera.position, target: camera.target, up: [0, 1, 0], verticalFovDegrees: 1 },
      blas: { id: "ref", vertices: positions, indices: geometry.indices },
      materials: [adaptPathTraceRenderPacketMaterial(metal)], environment: [1, 1, 1], rouletteStart: 64 });
    for (let ordinal = 0; ordinal < 512; ordinal++) expect(formal.traceSample(0, 0, ordinal, 8))
      .toEqual(reference.traceSample(0, 0, ordinal, 8));
  });
  it("applies near/far planes to primary visibility", () => {
    const make = (near: number, far: number) => createPathTraceRenderPacketKernel({ width: 1, height: 1,
      packet: packet(), camera: { ...camera, near, far }, environment: [1, 2, 4], rouletteStart: 64 });
    expect(make(0.1, 2).traceSample(0, 0, 0, 0)).toEqual([1, 2, 4]);
    expect(make(4, 10).traceSample(0, 0, 0, 0)).toEqual([1, 2, 4]);
    expect(make(0.1, 4).traceSample(0, 0, 0, 0)).toEqual(make(0.1, 100).traceSample(0, 0, 0, 0));
  });
  it("snapshots geometry, material, transform and camera inputs", () => {
    const ownGeometry = { ...geometry, vertices: geometry.vertices.slice(), indices: geometry.indices.slice() };
    const ownColor: [number, number, number] = [0.5, 0.25, 0.75], ownTransform = matrix();
    const ownCamera = { ...camera, position: [0, 0, 3] as [number, number, number] };
    const kernel = createPathTraceRenderPacketKernel({ width: 1, height: 1, camera: ownCamera,
      packet: { geometries: [ownGeometry], materials: [{ ...material, baseColor: ownColor }], instances: [instance("own", material.id, ownTransform)] },
      environment: [1, 2, 4], rouletteStart: 64 });
    const before = kernel.traceSample(0, 0, 0, 0);
    ownGeometry.vertices.fill(99); ownGeometry.indices.fill(2); ownColor.fill(0); ownTransform.fill(0); ownCamera.position.fill(99);
    expect(kernel.traceSample(0, 0, 0, 0)).toEqual(before);
  });
  it.each(["baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture", "emissiveTexture"] as const)
    ("rejects unsupported %s before omitting the authored feature", key => {
      expect(() => adaptPathTraceRenderPacketMaterial({ ...material, [key]: { texture: "authored" } })).toThrow(/unsupported/);
    });
  it("rejects single-sided, layered, deformation, non-unit normals, LOD and perspective matrices", () => {
    expect(() => adaptPathTraceRenderPacketMaterial({ ...material, doubleSided: false })).toThrow(/single-sided/);
    expect(() => adaptPathTraceRenderPacketMaterial({ ...material, layered: {} })).toThrow(/layered/);
    expect(() => buildPathTraceRenderPacketScene({ ...packet(), deformation: {} } as RenderPacket)).toThrow(/deformation/);
    const smooth = geometry.vertices.slice(); smooth[3] = 0.1;
    expect(() => buildPathTraceRenderPacketScene({ ...packet(), geometries: [{ ...geometry, vertices: smooth }] })).toThrow(/normal/);
    expect(() => buildPathTraceRenderPacketScene({ ...packet(), instances: [{ ...instance(), lod: {} }] } as RenderPacket)).toThrow(/LOD/);
    const perspective = matrix(); perspective[3] = 0.1;
    expect(() => buildPathTraceRenderPacketScene({ ...packet(), instances: [instance("projective", material.id, perspective)] })).toThrow(/affine/);
  });
  it("rejects section cameras and preserves validated scene-local frame metadata", () => {
    expect(() => createPathTraceRenderPacketKernel({ width: 1, height: 1, packet: packet(), environment: [1, 1, 1],
      camera: { ...camera, schemaVersion: 3, clippingPlane: [0, 1, 0, 0] } })).toThrow(/section/);
    const framed = createPathTraceRenderPacketKernel({ width: 1, height: 1, packet: packet(), environment: [1, 1, 1],
      camera: { ...camera, schemaVersion: 2, coordinateFrame: { schemaVersion: 1,
        profile: RUNTIME_COORDINATE_PROFILE, origin: { x: 1000, y: 0, z: 0 } } } });
    const plain = createPathTraceRenderPacketKernel({ width: 1, height: 1, packet: packet(), camera, environment: [1, 1, 1] });
    expect(framed.coordinateFrame!.origin).toEqual({ x: 1000, y: 0, z: 0 });
    for (let i = 0; i < 64; i++) expect(framed.traceSample(0, 0, i, 19)).toEqual(plain.traceSample(0, 0, i, 19));
  });
  it.each(["MASK", "BLEND"] as const)("rejects authored %s alpha instead of omitting its geometry", alphaMode => {
    expect(() => createPathTraceRenderPacketKernel({ width: 1, height: 1, camera,
      packet: { ...packet(), materials: [{ ...material, alphaMode }] }, environment: [1, 1, 1] })).toThrow(/alphaMode/);
  });
  it("rejects vertex color and duplicate resources", () => {
    expect(() => buildPathTraceRenderPacketScene({ ...packet(), geometries: [{ ...geometry,
      colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]) }] })).toThrow(/vertex colors/);
    expect(() => buildPathTraceRenderPacketScene({ ...packet(), instances: [instance(), instance()] })).toThrow(/duplicate/);
    expect(() => buildPathTraceRenderPacketScene({ ...packet(), materials: [material, material] })).toThrow(/duplicate/);
  });
});
