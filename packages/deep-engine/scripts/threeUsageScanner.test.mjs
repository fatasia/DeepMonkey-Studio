import { test } from "node:test";
import assert from "node:assert/strict";
import { scanThreeUsage } from "./threeUsageScanner.mjs";

test("counts aliases, static bracket access, and type references without shadowed locals", () => {
  const result = scanThreeUsage([{ file: "case.ts", code: `
    import * as T from 'three';
    import { Mesh as Shape, type Object3D } from 'three';
    new T.Vector3(); new T['BoxGeometry'](); new Shape();
    let value: T.Vector3; let typed: Object3D;
    function shadow(T: any, Shape: any) { new T.Fake(); new Shape(); }
  ` }]);
  assert.deepEqual(result.usages.map(({ symbol, kind }) => [symbol, kind]), [
    ["Vector3", "value"], ["BoxGeometry", "value"], ["Mesh", "value"], ["Vector3", "type"], ["Object3D", "type"],
  ]);
  assert.equal(result.unresolved.length, 0);
});

test("marks dynamic and embedded evidence as unresolved instead of claiming coverage", () => {
  const result = scanThreeUsage([{ file: "case.ts", code: `
    import * as THREE from 'three';
    const alias = THREE; THREE[key]();
    import('three/webgpu');
    export * from 'three';
    const script = "new THREE.Mesh()";
    // THREE.CommentOnly should never be a use.
  ` }]);
  assert.equal(result.usages.length, 0);
  assert.deepEqual(result.unresolved.map(({ kind }) => kind), [
    "namespace-escape-or-dynamic-access", "namespace-escape-or-dynamic-access", "dynamic-import", "re-export", "embedded-script-candidate",
  ]);
});

test("keeps addon and type-only imports separate", () => {
  const result = scanThreeUsage([{ file: "case.ts", code: `
    import type { Vector3 } from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    let vector: Vector3; new GLTFLoader();
  ` }]);
  assert.deepEqual(result.usages.map(({ module, symbol, kind }) => [module, symbol, kind]), [
    ["three", "Vector3", "type"], ["three/addons/loaders/GLTFLoader.js", "GLTFLoader", "value"],
  ]);
});

test("reports syntax errors and produces deterministic output", () => {
  const sources = [{ file: "bad.ts", code: "const x = ;" }];
  const first = scanThreeUsage(sources);
  assert.ok(first.unresolved.some(({ kind }) => kind === "parse-error"));
  assert.deepEqual(first, scanThreeUsage(sources));
});

test("binds JavaScript files and ignores unrelated property symbols", () => {
  const result = scanThreeUsage([{ file: "case.js", code: `
    import { Mesh } from 'three';
    function legacy(value) { this.Mesh(value); }
    new Mesh();
  ` }]);
  assert.deepEqual(result.usages.map(({ symbol }) => symbol), ["Mesh"]);
});
