import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { captureAuthorMorphSource } from "./authorMorphSource.js";
import { cpuDeformMorphVertices, prepareMorphInput } from "../webgpu/gpuMorphPacking.js";

function fixture(relative = true) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 2, 3, 4, 5, 6], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 0], 3));
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([2, 0, 1, -1, 3, 0], 3),
    new THREE.Float32BufferAttribute([0, 1, 0, 1, 0, 2], 3)];
  geometry.morphAttributes.normal = [new THREE.Float32BufferAttribute([0, 1, 0, 1, 0, 0], 3),
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 0, 1], 3)];
  geometry.morphTargetsRelative = relative;
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.morphTargetInfluences = [-0.25, 0.75];
  return { geometry, mesh };
}

describe("author morph source", () => {
  it.each([true, false])("matches real Three positions for relative=%s including negative weights", relative => {
    const { geometry, mesh } = fixture(relative), snapshot = captureAuthorMorphSource(geometry, { id: "morph", revision: 2 });
    const output = cpuDeformMorphVertices(prepareMorphInput(snapshot.source, snapshot.captureWeights(mesh, 7)));
    for (let vertex = 0; vertex < 2; vertex++) {
      const expected = mesh.getVertexPosition(vertex, new THREE.Vector3());
      const actual = new THREE.Vector3(output[vertex * 12], output[vertex * 12 + 1], output[vertex * 12 + 2]);
      expect(actual.distanceTo(expected)).toBeLessThan(1e-6);
      const normal = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("normal"), vertex);
      const base = normal.clone();
      for (let target = 0; target < 2; target++) {
        const value = new THREE.Vector3().fromBufferAttribute(geometry.morphAttributes.normal![target]!, vertex);
        if (!relative) value.sub(base);
        normal.addScaledVector(value, mesh.morphTargetInfluences![target]!);
      }
      normal.normalize();
      expect(new THREE.Vector3(output[vertex * 12 + 4], output[vertex * 12 + 5], output[vertex * 12 + 6]).distanceTo(normal)).toBeLessThan(1e-6);
    }
  });

  it("separates shared geometry from per-object dynamic weights and owns every snapshot", () => {
    const { geometry, mesh } = fixture(), second = new THREE.Mesh(geometry, mesh.material);
    second.morphTargetInfluences = [1, 0];
    const captured = captureAuthorMorphSource(geometry, { id: "shared", revision: 0 });
    const a = captured.captureWeights(mesh, 0), b = captured.captureWeights(second, 0);
    expect([...a.values]).toEqual([-0.25, 0.75]); expect([...b.values]).toEqual([1, 0]);
    mesh.morphTargetInfluences![0] = 2; geometry.attributes.position!.setX(0, 99);
    geometry.morphAttributes.position![0]!.setX(0, 88);
    expect(captured.source.positions[0]).toBe(1);
    expect(captured.source.primitive.targets[0]!.positionDeltas![0]).toBe(2);
    expect(a.values[0]).toBe(-0.25);
    expect(captured.captureWeights(mesh, 1).values[0]).toBe(2);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("applies explicit remap including repeated vertices to every base and target stream", () => {
    const { geometry, mesh } = fixture(), remap = new Uint32Array([1, 0, 1]);
    const snapshot = captureAuthorMorphSource(geometry, { id: "split", revision: 0, vertexRemap: remap });
    remap.fill(0);
    expect([...snapshot.source.positions]).toEqual([4, 5, 6, 1, 2, 3, 4, 5, 6]);
    const output = cpuDeformMorphVertices(prepareMorphInput(snapshot.source, snapshot.captureWeights(mesh, 0)));
    for (const [out, authored] of [1, 0, 1].entries()) {
      expect([...output.slice(out * 12, out * 12 + 3)]).toEqual(mesh.getVertexPosition(authored, new THREE.Vector3()).toArray());
    }
  });

  it("supports normalized integer and interleaved attributes using bridge component decoding", () => {
    const { geometry, mesh } = fixture();
    const buffer = new THREE.InterleavedBuffer(new Float32Array([99, 1, 2, 3, 99, 4, 5, 6]), 4);
    geometry.setAttribute("position", new THREE.InterleavedBufferAttribute(buffer, 3, 1));
    geometry.morphAttributes.position![0] = new THREE.BufferAttribute(new Int16Array([32767, 0, -32768, 0, 32767, 0]), 3, true);
    geometry.morphAttributes.position![1] = new THREE.InterleavedBufferAttribute(
      new THREE.InterleavedBuffer(new Float32Array([0, 1, 0, 99, 1, 0, 2, 99]), 4), 3, 0);
    const captured = captureAuthorMorphSource(geometry, { id: "interleaved", revision: 0 });
    expect([...captured.source.positions]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...captured.source.primitive.targets[0]!.positionDeltas!]).toEqual([1, 0, -1, 0, 1, 0]);
    expect([...captured.source.primitive.targets[1]!.positionDeltas!]).toEqual([0, 1, 0, 1, 0, 2]);
    expect(() => prepareMorphInput(captured.source, captured.captureWeights(mesh, 0))).not.toThrow();
  });

  it("supports normal-only morph and missing base normal for position-only morph", () => {
    const a = fixture(); delete a.geometry.morphAttributes.position;
    const normalOnly = captureAuthorMorphSource(a.geometry, { id: "normal", revision: 0 });
    expect(normalOnly.source.primitive.targets[0]!.positionDeltas).toBeUndefined();
    expect(() => prepareMorphInput(normalOnly.source, normalOnly.captureWeights(a.mesh, 0))).not.toThrow();
    const b = fixture(); delete b.geometry.morphAttributes.normal; b.geometry.deleteAttribute("normal");
    const positionOnly = captureAuthorMorphSource(b.geometry, { id: "position", revision: 0 });
    expect(positionOnly.source.normals).toBeUndefined();
    expect(() => prepareMorphInput(positionOnly.source, positionOnly.captureWeights(b.mesh, 0))).not.toThrow();
  });

  it("rejects mismatched, unsupported or invalid source input", () => {
    const capture = (geometry: unknown) => captureAuthorMorphSource(geometry, { id: "invalid", revision: 0 });
    const a = fixture(); a.geometry.morphAttributes.normal!.pop(); expect(() => capture(a.geometry)).toThrow("counts");
    const b = fixture(); b.geometry.morphAttributes.position![0] = new THREE.Float32BufferAttribute([1, 2, 3], 3);
    expect(() => capture(b.geometry)).toThrow("count");
    const c = fixture(); c.geometry.morphAttributes.color = []; expect(() => capture(c.geometry)).toThrow("semantic");
    const d = fixture(); d.geometry.morphAttributes.position![0]!.setX(0, Infinity); expect(() => capture(d.geometry)).toThrow("float32");
    const e = fixture(); e.geometry.attributes.normal!.setZ(0, 2); expect(() => capture(e.geometry)).toThrow("non-unit");
    const f = fixture(); f.geometry.morphAttributes.position![0] = new THREE.Float16BufferAttribute([1, 2, 3, 4, 5, 6], 3);
    expect(() => capture(f.geometry)).toThrow("storage");
  });

  it("rejects invalid remaps, revisions and dynamic weights without altering earlier snapshots", () => {
    const { geometry, mesh } = fixture();
    for (const vertexRemap of [[], [-1], [2], [0.5], [NaN]]) {
      expect(() => captureAuthorMorphSource(geometry, { id: "bad", revision: 0, vertexRemap })).toThrow("vertexRemap");
    }
    expect(() => captureAuthorMorphSource(geometry, { id: "bad", revision: -1 })).toThrow("revision");
    const captured = captureAuthorMorphSource(geometry, { id: "valid", revision: 0 });
    const accepted = captured.captureWeights(mesh, 0);
    for (const weights of [[NaN, 0], [Infinity, 0], [0], [1e40, 0], [3e38, 0]]) {
      mesh.morphTargetInfluences = weights; expect(() => captured.captureWeights(mesh, 1)).toThrow();
    }
    expect(() => captured.captureWeights(mesh, -1)).toThrow("revision");
    expect(() => captured.captureWeights(fixture().mesh, 1)).toThrow("geometry");
    expect([...accepted.values]).toEqual([-0.25, 0.75]);
  });
});
