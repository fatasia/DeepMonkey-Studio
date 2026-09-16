import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ThreeProjectionBridge } from "./ThreeProjectionBridge.js";
import { accepted } from "./testFixture.js";
import { prepareRenderPacket } from "../renderPacket.js";
function fixture(enabled = true) {
  const material = new THREE.MeshStandardMaterial(), high = new THREE.Mesh(new THREE.BoxGeometry(), material), low = new THREE.Mesh(new THREE.PlaneGeometry(), material);
  const lod = new THREE.LOD(); lod.addLevel(high, 0); lod.addLevel(low, 10, 0.2); lod.autoUpdate = false; low.visible = false;
  const hooks = { objectBeforeRender: THREE.Object3D.prototype.onBeforeRender, objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow, objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender, materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey };
  const bridge = new ThreeProjectionBridge({ hooks, capabilities: { authorLod: enabled } });
  const project = () => { lod.updateMatrixWorld(true); return bridge.project(lod, { cameraLayerMask: 1 }); };
  return { material, high, low, lod, bridge, project };
}
describe("real Three author-selected LOD projection", () => {
  it("is capability gated and leaves ordinary meshes unchanged", () => {
    const f = fixture(false); expect(f.project().ok).toBe(false);
    expect(f.bridge.project(f.high, { cameraLayerMask: 1 }).ok).toBe(true);
  });
  it("keeps all genuine geometry, identity and batch buffers stable across selection-only revisions", () => {
    const f = fixture(), update = vi.spyOn(f.lod, "update"), disposal = vi.spyOn(f.high.geometry, "dispose");
    const first = accepted(f.project()); first.acknowledge();
    expect(first.packet.instances).toHaveLength(1); expect(first.packet.geometries).toHaveLength(2);
    const a = prepareRenderPacket(first.packet).batches[0]!;
    f.high.visible = false; f.low.visible = true;
    const second = accepted(f.project()), b = prepareRenderPacket(second.packet).batches[0]!;
    expect(second.update).toBe("instances"); expect(second.packet.instances[0]!.id).toBe(first.packet.instances[0]!.id);
    expect(second.packet.geometries[0]).toBe(first.packet.geometries[0]); expect(second.packet.geometries[1]).toBe(first.packet.geometries[1]);
    expect(b.key).toBe(a.key); expect(b.data).toEqual(a.data);
    expect(b.lod).toMatchObject({ strategy: "author-selected", revision: 1, selectedLevels: [1] });
    expect(a.lod).toMatchObject({ revision: 0, selectedLevels: [0] });
    expect(update).not.toHaveBeenCalled(); expect(disposal).not.toHaveBeenCalled(); expect(f.low.parent).toBe(f.lod);
  });
  it("preserves manual zero/multiple choices and layer masking without discarding hidden geometry", () => {
    const f = fixture(); f.high.visible = false;
    const zero = accepted(f.project()); expect(zero.packet.instances[0]!.lod).toMatchObject({ selectedLevels: [] });
    expect(prepareRenderPacket(zero.packet).geometries.size).toBe(2);
    f.high.visible = true; f.low.visible = true; expect(accepted(f.project()).packet.instances[0]!.lod).toMatchObject({ selectedLevels: [0,1] });
    f.lod.layers.set(2); f.low.layers.set(2);
    expect(accepted(f.project()).packet.instances[0]!.lod).toMatchObject({ selectedLevels: [0] });
    f.lod.visible = false; expect(accepted(f.project()).packet.instances).toHaveLength(0);
  });
  it("keeps separate author selections even when genuine geometry and materials are shared", () => {
    const f = fixture(), other = new THREE.LOD(), root = new THREE.Group();
    other.autoUpdate = false;
    other.addLevel(new THREE.Mesh(f.high.geometry, f.material), 0);
    other.addLevel(new THREE.Mesh(f.low.geometry, f.material), 10, 0.2);
    other.levels[0]!.object.visible = false;
    root.add(f.lod, other); root.updateMatrixWorld(true);
    const packet = accepted(f.bridge.project(root, { cameraLayerMask: 1 })).packet;
    const prepared = prepareRenderPacket(packet);
    expect(prepared.geometries.size).toBe(2); expect(prepared.batches).toHaveLength(2);
    expect(prepared.batches.map(batch => batch.lod)).toMatchObject([{ selectedLevels: [0] }, { selectedLevels: [1] }]);
    expect(prepared.batches[0]!.key).not.toBe(prepared.batches[1]!.key);
  });
  it("versions real geometry changes and invalidates full projection without disposing author resources", () => {
    const f = fixture(), first = accepted(f.project()); first.acknowledge();
    const position = f.low.geometry.getAttribute("position"); position.setX(0, 2); position.needsUpdate = true;
    const second = accepted(f.project());
    expect(second.update).toBe("full"); expect(second.packet.instances[0]!.lod).toMatchObject({ revision: 1 });
    expect(second.packet.geometries[1]).not.toBe(first.packet.geometries[1]);
    expect(second.packet.geometries[0]).toBe(first.packet.geometries[0]);
  });
  it.each(["material", "transform", "distance", "group", "extra"])("diagnoses incompatible %s without changing author objects", kind => {
    const f = fixture();
    if (kind === "material") f.low.material = f.material.clone();
    if (kind === "transform") f.low.position.x = 1;
    if (kind === "distance") f.lod.levels[1]!.distance = NaN;
    if (kind === "group") (f.high as THREE.Mesh).material = [f.material, f.material];
    if (kind === "extra") f.lod.add(new THREE.Object3D());
    const result = f.project(); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe("root");
    expect(f.low.parent).toBe(f.lod);
  });
});
