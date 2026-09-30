import test from "node:test";
import assert from "node:assert/strict";
import { compareShadowVisibility, decodeShadowUniform } from "./j3ShadowVisibilityParity.mjs";

function setup() {
  const base = { packageHash: "fixture-package", packetHash: "fixture-packet", width: 128, height: 128, gpuErrors: [] };
  const vp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const profile = { depthBias: .00075, shadowMapSize: 2048, maxShadowDistance: 40, surfaceToLight: [-.6, -.3, Math.sqrt(.55)] };
  const plan = { ...base, profile, cases: [] }, web = { ...base, frames: [] }, native = { ...base, frames: [] };
  const makeUniform = (count, n) => {
    const raw = Array(n ? 84 : 156).fill(0), split = n ? 64 : 128, blend = n ? 68 : 136, params = n ? 76 : 152;
    for (let index = 0; index < count; index++) { raw[split + index] = raw[blend + index] = (index + 1) * 40 / count; }
    raw[params] = count; raw[params + 1] = .00075; raw[params + 2] = 1 / 2048; return raw;
  };
  for (const [cameraId, count] of [["axis", 45], ["oblique", 40]]) {
    const points = Array.from({ length: count }, (_, i) => ({ pixel: i, expectedWorldNormal: [0, 0, 1], baselineOccluded: i < 15 }));
    for (const cascadeCount of [1, 4]) {
      plan.cases.push({ cameraId, cascadeCount, instanceId: "triangle", points });
      for (const scenario of ["baseline", "cube-caster-disabled", "triangle-receiver-disabled"]) for (const round of [0, 1]) {
        web.frames.push({ cameraId, cascadeCount, scenario, round, actualVP: vp, expectedVP: vp,
          shadowUniform: makeUniform(cascadeCount, false), samples: points.map((p, i) => ({ pixel: p.pixel, instanceId: "triangle",
            hdr: scenario === "baseline" && i < 15 ? [0, 0, 0] : [1, .5, .25] })) });
      }
    }
    for (const cascadeCount of [2, 4]) for (const scenario of ["baseline", "unshadowed-control"]) for (const round of [0, 1]) {
      native.frames.push({ cameraId, cascadeCount, scenario, round, actualVP: vp,
        shadowUniform: makeUniform(cascadeCount, true), shadowMapHash: "a".repeat(64), shadowMapSamples: cascadeCount * 2048 ** 2,
        shadowMapNonClear: 123, lighting: { shadows: scenario === "baseline" ? 1 : 0, environment: 0, exposure: 1,
          localLights: 0, authoredMode: 2, direction: profile.surfaceToLight, radiance: [2.5, 2.4, 2.25] },
        samples: points.map((p, i) => ({ pixel: p.pixel, instanceId: "triangle", hdr: scenario === "baseline" && i < 15 ? [0, 0, 0] : [1, .5, .25] })) });
    }
  }
  return { plan, web, native };
}

test("decodes each existing GPU uniform ABI without padding Native to the Web size", () => {
  const f = setup(); assert.equal(decodeShadowUniform(f.web.frames[0].shadowUniform, false).count, 1);
  assert.equal(decodeShadowUniform(f.native.frames[0].shadowUniform, true).count, 2);
  assert.throws(() => decodeShadowUniform(f.native.frames[0].shadowUniform, false));
});
test("only common four cascades pair, all 85 masks and both rounds; Native2/Web1 stay unpaired", () => {
  const f = setup(), result = compareShadowVisibility(f.plan, f.web, f.native);
  assert.equal(result.passed, true); assert.equal(result.pointsCompared, 170); assert.equal(result.cases.length, 2);
  assert.equal(result.maxVisibilityIntervalGap, 0); assert(result.unpairedDiagnostics.native.includes("two-cascade"));
});
test("a real visibility difference records every mismatching frozen pixel without filtering or fitting", () => {
  const f = setup();
  f.native.frames.filter(row => row.cascadeCount === 4 && row.scenario === "baseline").forEach(row => { row.samples[0].hdr = [.5, .25, .125]; });
  const result = compareShadowVisibility(f.plan, f.web, f.native);
  assert.equal(result.passed, false); assert.equal(result.differences.length, 4); assert(result.maxVisibilityIntervalGap > .49);
  assert.equal(result.pointsCompared, 170);
});
test("different depth-fit matrices are retained but do not replace actual visibility criteria", () => {
  const f = setup(); f.native.frames.forEach(row => { row.shadowUniform[0] = .3; });
  assert.equal(compareShadowVisibility(f.plan, f.web, f.native).passed, true);
});
test("changed control maps, lighting, camera, mask, source or repeated HDR fail closed", () => {
  for (const mutate of [
    f => { f.native.frames.find(row => row.cascadeCount === 4 && row.scenario === "unshadowed-control").shadowMapHash = "b".repeat(64); },
    f => { f.native.frames.find(row => row.cascadeCount === 4).lighting.environment = 1; },
    f => { f.native.frames.find(row => row.cascadeCount === 4).actualVP = []; },
    f => { f.native.frames.find(row => row.cascadeCount === 4).samples.pop(); },
    f => { f.native.packetHash = "stale"; },
    f => { f.native.frames.find(row => row.cascadeCount === 4 && row.scenario === "baseline" && row.round === 1).samples[0].hdr = [.25, .125, .0625]; },
  ]) {
    const f = setup(); mutate(f); assert.throws(() => compareShadowVisibility(f.plan, f.web, f.native));
  }
});
