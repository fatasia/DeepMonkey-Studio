import test from "node:test";
import assert from "node:assert/strict";
import { assertLabInputs, assertRuntimeDependencies, bundledInputBytes } from "./labIsolationPolicy.mjs";

const three = "../../node_modules/.pnpm/three@0.186.1/node_modules/three/build/three.webgpu.js";
test("the pinned compression codec is the only runtime dependency", () => {
  assertRuntimeDependencies({ fflate: "0.8.3" });
  for (const dependencies of [{ three: "0.186.1" }, { fflate: "^0.8.3" }, { react: "19" }]) {
    assert.throws(() => assertRuntimeDependencies(dependencies), /Unexpected runtime dependency/);
  }
});
test("independent entries reject emitted Three and retain tree-shaken provenance", () => {
  assertLabInputs({ [three]: "hash" }, [], { [three]: 0 });
  assert.throws(() => assertLabInputs({ [three]: "hash" }, [], { [three]: 1 }), /escaped/);
  assert.throws(() => assertLabInputs({ [three]: "hash" }, []), /escaped/);
  assertLabInputs({ [three]: "hash" }, ["three"], { [three]: 100 });
  assert.throws(() => assertLabInputs({}, ["react"]), /allowlists/);
});
test("codec paths allow the pinned package and reject other external inputs", () => {
  assertLabInputs({ "src/index.ts": "hash", "../../node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/browser.js": "hash" }, []);
  assert.throws(() => assertLabInputs({ "../../node_modules/.pnpm/fflate@0.8.2/node_modules/fflate/esm/browser.js": "hash" }, []), /escaped/);
  assert.throws(() => assertLabInputs({ "../../apps/web/src/index.ts": "hash" }, []), /escaped/);
});
test("emitted byte counts include every output and preserve zero-byte inputs", () => {
  assert.deepEqual(bundledInputBytes({ inputs: { a: {}, b: {} }, outputs: {
    one: { inputs: { a: { bytesInOutput: 3 } } }, two: { inputs: { a: { bytesInOutput: 7 } } },
  } }), { a: 10, b: 0 });
});
