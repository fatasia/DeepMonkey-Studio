import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { OrdinaryPicking } from "./ordinaryPicking";
import { buildPickingIndex } from "./ordinaryPickingBuild";
import { copyPickingSnapshot, eligiblePickingMesh, geometryStamp, type PickingBuilder, type PickingSnapshot } from "./ordinaryPickingGeometry";

const material = () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const mesh = () => new THREE.Mesh(new THREE.PlaneGeometry(4, 4, 12, 12), material());
const ray = (x = 0.123, y = 0.234) => new THREE.Raycaster(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
function picker(options: ConstructorParameters<typeof OrdinaryPicking>[0] = {}) {
  const builder: PickingBuilder = { build: vi.fn(async (snapshot) => buildPickingIndex(snapshot)), dispose: vi.fn() };
  return { picker: new OrdinaryPicking({ minTriangles: 1, builder, ...options }), builder };
}
async function settle(target: OrdinaryPicking) { await vi.waitFor(() => { expect(target.diagnostics().building).toBe(false); expect(target.diagnostics().queued).toBe(0); }); }
function compare(actual: THREE.Intersection[], expected: THREE.Intersection[]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((hit, i) => {
    const reference = expected[i]!;
    expect(hit.object).toBe(reference.object); expect(hit.distance).toBeCloseTo(reference.distance, 9);
    expect(hit.point.distanceTo(reference.point)).toBeLessThan(1e-9); expect(hit.faceIndex).toBe(reference.faceIndex);
    expect(hit.face?.a).toBe(reference.face?.a); expect(hit.face?.b).toBe(reference.face?.b); expect(hit.face?.c).toBe(reference.face?.c);
    expect(hit.face?.materialIndex).toBe(reference.face?.materialIndex);
    if (reference.face) expect(hit.face?.normal.distanceTo(reference.face.normal)).toBeLessThan(1e-9);
    if (reference.uv) expect(hit.uv?.distanceTo(reference.uv)).toBeLessThan(1e-9);
    if (reference.uv1) expect(hit.uv1?.distanceTo(reference.uv1)).toBeLessThan(1e-9);
    if (reference.normal) expect(hit.normal?.distanceTo(reference.normal)).toBeLessThan(1e-9);
  });
}

describe("ordinary high-polygon picking", () => {
  it("first click is synchronous fallback, then preserves all shared-geometry hit fields and ties without changing index/prototypes", async () => {
    const { picker: target, builder } = picker(); const first = mesh(); const second = new THREE.Mesh(first.geometry, material());
    const roots = [first, second]; roots.forEach((root) => root.updateMatrixWorld());
    const index = first.geometry.index; const array = index!.array; const version = index!.version;
    const originalRaycast = THREE.Mesh.prototype.raycast;
    compare(target.intersectObjects(ray(), roots), ray().intersectObjects(roots, true));
    expect(builder.build).not.toHaveBeenCalled(); await settle(target);
    expect(builder.build).toHaveBeenCalledTimes(1); expect(target.diagnostics().ready).toBe(1);
    for (const point of [[0, 0], [0.123, 0.234], [1.999, 1.999], [3, 3]]) compare(target.intersectObjects(ray(...point), roots), ray(...point).intersectObjects(roots, true));
    expect(first.geometry.index).toBe(index); expect(index!.array).toBe(array); expect(index!.version).toBe(version);
    expect(THREE.Mesh.prototype.raycast).toBe(originalRaycast); expect(first.geometry).not.toHaveProperty("boundsTree"); target.dispose();
  });

  it("preserves world transforms, mirrored/non-uniform parent shear, near/far and both material sides", async () => {
    const { picker: target } = picker(); const object = mesh(); const parent = new THREE.Group(); parent.add(object);
    parent.scale.set(2, 0.7, 1.3); parent.rotation.y = 0.2; object.scale.set(-1, 1.3, 0.8); object.rotation.y = -0.3; object.position.z = 0.2;
    parent.updateMatrixWorld(true); target.intersectObjects(ray(), [parent]); await settle(target);
    for (const side of [THREE.DoubleSide, THREE.BackSide, THREE.FrontSide]) {
      object.material.side = side;
      for (const [near, far] of [[0, Infinity], [4, 5.5], [0, 1], [6, 9]]) {
        const caster = ray(); caster.near = near!; caster.far = far!;
        compare(target.intersectObjects(caster, [parent]), caster.intersectObjects([parent], true));
      }
    }
    target.dispose();
  });

  it("retains hidden-child, model-root filtering, layer-mask and custom false propagation semantics", async () => {
    const { picker: target } = picker(); const root = new THREE.Group(); const object = mesh(); root.add(object); object.visible = false; root.layers.set(3);
    target.intersectObjects(ray(), [root]); await settle(target);
    compare(target.intersectObjects(ray(), [root]), ray().intersectObjects([root], true));
    expect(target.intersectObjects(ray(), [])).toEqual([]);
    object.layers.set(2); compare(target.intersectObjects(ray(), [root]), ray().intersectObjects([root], true));
    root.layers.set(0); object.layers.set(0); root.raycast = (() => false) as THREE.Object3D["raycast"];
    compare(target.intersectObjects(ray(), [root]), ray().intersectObjects([root], true)); target.dispose();
  });

  it("keeps drawRange, overlapping/out-of-order groups, single-material group gaps, normals and UV1", async () => {
    const { picker: target } = picker(); const object = mesh(); const geometry = object.geometry;
    geometry.setAttribute("uv1", geometry.getAttribute("uv").clone());
    geometry.clearGroups(); geometry.addGroup(72, 180, 1); geometry.addGroup(0, 180, 0); geometry.addGroup(60, 66, 1);
    geometry.setDrawRange(12, 420); const other = material(); object.material = [material(), other] as unknown as THREE.MeshBasicMaterial;
    target.intersectObjects(ray(), [object]); await settle(target);
    for (const y of [-1.2, 0, 1.2]) for (const x of [-1.2, 0, 1.2]) compare(target.intersectObjects(ray(x, y), [object]), ray(x, y).intersectObject(object, true));
    object.material = other;
    for (const y of [-1.2, 0, 1.2]) for (const x of [-1.2, 0, 1.2]) compare(target.intersectObjects(ray(x, y), [object]), ray(x, y).intersectObject(object, true));
    geometry.setDrawRange(0, Infinity); target.intersectObjects(ray(), [object]); await settle(target);
    compare(target.intersectObjects(ray(), [object]), ray().intersectObject(object, true)); expect(target.diagnostics().builds).toBe(2); target.dispose();
  });

  it("supports non-indexed geometry and preserves its absent index", async () => {
    const { picker: target } = picker(); const object = new THREE.Mesh(mesh().geometry.toNonIndexed(), material());
    target.intersectObjects(ray(), [object]); await settle(target);
    compare(target.intersectObjects(ray(), [object]), ray().intersectObject(object, true)); expect(object.geometry.index).toBeNull(); target.dispose();
  });

  it("invalidates position/index replacements and versions without losing fallback hits", async () => {
    const { picker: target } = picker(); const object = mesh(); target.intersectObjects(ray(), [object]); await settle(target);
    const position = object.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) position.setZ(i, 1);
    position.needsUpdate = true; object.geometry.computeBoundingSphere();
    compare(target.intersectObjects(ray(), [object]), ray().intersectObject(object, true)); expect(target.diagnostics().ready).toBe(0); await settle(target);
    compare(target.intersectObjects(ray(), [object]), ray().intersectObject(object, true));
    object.geometry.setIndex(object.geometry.index!.clone()); target.intersectObjects(ray(), [object]); await settle(target);
    object.geometry.index!.needsUpdate = true; target.intersectObjects(ray(), [object]); await settle(target);
    expect(target.diagnostics().builds).toBe(4); target.dispose();
  });

  it("excludes dynamic, skinned, morph, instanced, custom-raycast and fragments roots", async () => {
    const { picker: target, builder } = picker(); const dynamic = mesh(); (dynamic.geometry.getAttribute("position") as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const morph = mesh(); morph.geometry.morphAttributes.position = [morph.geometry.getAttribute("position").clone()];
    const ordinary = mesh(); const skinned = new THREE.SkinnedMesh(ordinary.geometry, material()); const instanced = new THREE.InstancedMesh(ordinary.geometry, material(), 1);
    const custom = mesh(); custom.raycast = () => undefined;
    for (const object of [dynamic, morph, skinned, instanced, custom]) expect(eligiblePickingMesh(object, 1, Infinity)).toBe(false);
    target.intersectObjects(ray(), [ordinary, dynamic, custom], new Set([ordinary])); await settle(target); expect(builder.build).not.toHaveBeenCalled(); target.dispose();
  });

  it("cancels queued/building geometry, disable and Viewer disposal; re-enable can build again", async () => {
    const { picker: target, builder } = picker(); const object = mesh(); target.intersectObjects(ray(), [object]); object.geometry.dispose(); await settle(target);
    expect(builder.build).not.toHaveBeenCalled(); expect(target.diagnostics().ready).toBe(0);
    target.intersectObjects(ray(), [object]); target.setEnabled(false); await settle(target); expect(builder.dispose).toHaveBeenCalled();
    target.setEnabled(true); target.intersectObjects(ray(), [object]); await settle(target); expect(target.diagnostics().ready).toBe(1);
    object.geometry.dispose(); expect(target.diagnostics().indexBytes).toBe(0); target.dispose();
    compare(target.intersectObjects(ray(), [object]), ray().intersectObject(object, true)); expect(target.diagnostics().enabled).toBe(false);
  });

  it("rejects a stale in-flight result and cancels pending build when geometry is disposed", async () => {
    let release: ((value: ReturnType<typeof buildPickingIndex>) => void) | undefined; let snapshot: PickingSnapshot | undefined; let signal: AbortSignal | undefined;
    const builder: PickingBuilder = { build: async (value, abort) => { snapshot = value; signal = abort; return new Promise((resolve) => { release = resolve; }); }, dispose() {} };
    const { picker: target } = picker({ builder }); const object = mesh(); target.intersectObjects(ray(), [object]);
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); (object.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    release!(buildPickingIndex(snapshot!)); await settle(target); expect(target.diagnostics().ready).toBe(0);
    target.intersectObjects(ray(), [object]); await vi.waitFor(() => expect(signal?.aborted).toBe(false)); object.geometry.dispose(); expect(signal!.aborted).toBe(true);
    release!(buildPickingIndex(snapshot!)); await settle(target); expect(target.diagnostics().ready).toBe(0); target.dispose();
  });

  it("keeps fallback usable after worker failure and respects memory/threshold limits", async () => {
    const failing: PickingBuilder = { build: vi.fn(async () => { throw new Error("worker failed"); }), dispose() {} };
    const { picker: target } = picker({ builder: failing }); const object = mesh(); target.intersectObjects(ray(), [object]); await settle(target);
    compare(target.intersectObjects(ray(), [object]), ray().intersectObject(object, true)); expect(failing.build).toHaveBeenCalledTimes(1); expect(target.diagnostics().fallbacks).toBe(1); target.dispose();
    for (const options of [{ minTriangles: 100000 }, { maxSnapshotBytes: 1 }, { maxCacheBytes: 1 }]) {
      const { picker: bounded } = picker(options); bounded.intersectObjects(ray(), [object]); await settle(bounded); expect(bounded.diagnostics().ready).toBe(0); bounded.dispose();
    }
  });

  it("copies snapshots without modifying or detaching originals and aborts on mutation during copying", async () => {
    const object = mesh(); const geometry = object.geometry; const stamp = geometryStamp(geometry); const original = stamp.positionArray;
    const snapshot = await copyPickingSnapshot(geometry, stamp, new AbortController().signal);
    expect(snapshot.position).not.toBe(original); expect(snapshot.position).toEqual(original); expect(snapshot.index).not.toBe(geometry.index!.array);
    structuredClone(snapshot, { transfer: [snapshot.position.buffer as ArrayBuffer, snapshot.index!.buffer as ArrayBuffer] }); expect(original.byteLength).toBeGreaterThan(0); expect(geometry.index!.array.byteLength).toBeGreaterThan(0);
    const pending = copyPickingSnapshot(geometry, stamp, new AbortController().signal); (geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds queued work and evicts older indexes under cache pressure", async () => {
    const first = mesh(); const second = mesh();
    const serialized = buildPickingIndex(await copyPickingSnapshot(first.geometry, geometryStamp(first.geometry), new AbortController().signal));
    const bytes = serialized.roots.reduce((sum, root) => sum + root.byteLength, 0) + serialized.indirectBuffer!.byteLength;
    const { picker: bounded, builder } = picker({ maxCacheBytes: bytes + 1 });
    bounded.intersectObjects(ray(), [first, second]); await settle(bounded);
    expect(bounded.diagnostics()).toMatchObject({ builds: 2, ready: 1, indexBytes: bytes });
    compare(bounded.intersectObjects(ray(), [second]), ray().intersectObject(second, true)); expect(builder.build).toHaveBeenCalledTimes(2); bounded.dispose();
    const { picker: queued, builder: pending } = picker(); queued.intersectObjects(ray(), Array.from({ length: 100 }, mesh));
    expect(queued.diagnostics().queued).toBeLessThanOrEqual(32); expect(pending.build).not.toHaveBeenCalled();
    queued.dispose(); await settle(queued); expect(queued.diagnostics()).toMatchObject({ queued: 0, ready: 0, indexBytes: 0 });
  });
});
