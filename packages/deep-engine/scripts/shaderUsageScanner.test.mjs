import assert from "node:assert/strict";
import { test } from "node:test";
import { scanShaderUsage } from "./shaderUsageScanner.mjs";

test("finds Three shader constructors, hooks, TSL, and embedded source", () => {
  const result = scanShaderUsage([{ file: "scene.ts", code: `
    import * as THREE from "three";
    import { ShaderMaterial as SM } from "three";
    import { texture, Fn } from "three/tsl";
    const a = new THREE.RawShaderMaterial();
    const c = new THREE["MeshStandardNodeMaterial"]();
    const b = new SM({ vertexShader: "void main(){ gl_Position=vec4(0.0); }" });
    b.onBeforeCompile = (shader) => shader.fragmentShader = shader.fragmentShader;
  ` }]);
  assert.deepEqual(result.evidence.map((item) => [item.kind, item.symbol]), [
    ["three-shader-type-import", "ShaderMaterial"],
    ["three-tsl-import", "Fn"],
    ["three-tsl-import", "texture"],
    ["three-shader-constructor", "RawShaderMaterial"],
    ["three-shader-constructor", "MeshStandardNodeMaterial"],
    ["embedded-glsl-hlsl", "literal"],
    ["three-shader-constructor", "ShaderMaterial"],
    ["vertex-source-property", "vertexShader"],
    ["compile-hook", "onBeforeCompile"],
    ["fragment-source-property", "fragmentShader"],
    ["fragment-source-property", "fragmentShader"],
  ]);
  assert.equal(result.unresolved.length, 0);
});

test("records WGSL, shader imports, standalone files, and dynamic gaps without storing source", () => {
  const result = scanShaderUsage([
    { file: "a.ts", code: `import shader from "./effect.wgsl?raw"; const code = "@fragment fn main() {}"; import("three/tsl");` },
    { file: "effect.wgsl", code: "@fragment fn main() {}" },
  ]);
  assert.deepEqual(result.evidence.map((item) => item.kind), ["embedded-wgsl", "shader-file-import", "standalone-shader"]);
  assert.equal(result.evidence.some((item) => "source" in item), false);
  assert.deepEqual(result.unresolved.map((item) => item.kind), ["dynamic-shader-import"]);
});

test("records TSL namespace imports as migration evidence", () => {
  const result = scanShaderUsage([{ file: "nodes.ts", code: `import * as TSL from "three/tsl"; TSL.texture(map);` }]);
  assert.deepEqual(result.evidence.map((item) => [item.kind, item.symbol]), [["three-tsl-namespace-import", "*"]]);
});

test("is deterministic, ignores comments, and exposes parse failures", () => {
  const sources = [{ file: "b.ts", code: "// material.onBeforeCompile\nconst bad = ;" }];
  const first = scanShaderUsage(sources);
  assert.deepEqual(first, scanShaderUsage(sources));
  assert.equal(first.evidence.length, 0);
  assert.deepEqual(first.unresolved.map((item) => item.kind), ["parse-error"]);
});
