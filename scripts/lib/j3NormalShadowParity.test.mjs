import test from "node:test";
import assert from "node:assert/strict";
import { compareNormalAttachments, validateWebNormalShadow } from "./j3NormalShadowParity.mjs";

function setup() {
  const base = { packageHash: "same-package", packetHash: "same-packet", width: 128, height: 128,
    actualNormalAttachments: true, gpuErrors: [] };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const rotated = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1];
  const plan = { ...base, profile: { depthBias: .00075, shadowMapSize: 2048, maxShadowDistance: 40 }, cases: [] };
  const web = { ...base, normalAttachment: "production-view-normal-rgba8unorm", frames: [] };
  const native = { ...base, normalAttachment: "production-world-normal-rgba8unorm", frames: [] };
  for (const cameraId of ["axis", "oblique"]) {
    for (const cascadeCount of [1, 4]) {
      plan.cases.push({ cameraId, cascadeCount, instanceId: "triangle", points: [{ pixel: 6991, expectedWorldNormal: [0, 0, 1],
        expectedViewNormal: cameraId === "axis" ? [0, 0, 1] : [-1, 0, 0] }] });
      const uniform = Array(156).fill(0); uniform[128 + cascadeCount - 1] = 40;
      uniform[152] = cascadeCount; uniform[153] = .00075; uniform[154] = 1 / 2048;
      for (const scenario of ["baseline", "cube-caster-disabled", "triangle-receiver-disabled"]) for (const round of [0, 1]) {
        web.frames.push({ cameraId, cascadeCount, scenario, round, actualVP: identity, expectedVP: identity,
          actualWorldToView: cameraId === "axis" ? identity : rotated, shadowUniform: uniform,
          samples: [{ pixel: 6991, instanceId: "triangle", encodedViewNormal: cameraId === "axis" ? [.5, .5, 1, .34] : [0, .5, .5, .34],
            hdr: [.7, .4, .1], linearDepth: 8, sampledShadowVisibility: scenario === "cube-caster-disabled" ? 1 : 0 }] });
      }
    }
    for (const round of [0, 1]) native.frames.push({ cameraId, round, actualVP: identity, defaultHdrUnchanged: true,
      samples: [{ pixel: 6991, instanceId: "triangle", encodedWorldNormal: [.5, .5, 1, .34], hdr: [.7, .4, .1] }] });
  }
  return { plan, web, native };
}

test("compares actual view/world attachments in their common world domain without claiming shadow parity", () => {
  const f = setup(), result = compareNormalAttachments(f.plan, f.web, f.native);
  assert.equal(result.passed, true); assert.equal(result.normalParity, true); assert.equal(result.shadowParity, false);
  assert.equal(result.maxWorldNormalAngleDegrees, 0);
});
test("a normal sign/coordinate corruption fails even with stable repeats", () => {
  const f = setup(); f.native.frames.forEach(frame => { frame.samples[0].encodedWorldNormal = [.5, .5, 0, .34]; });
  assert.throws(() => compareNormalAttachments(f.plan, f.web, f.native));
});
test("missing fixed mask points and stale source identities fail closed", () => {
  for (const mutate of [f => { f.web.frames[0].samples = []; }, f => { f.native.packageHash = "old-package"; }]) {
    const f = setup(); mutate(f); assert.throws(() => compareNormalAttachments(f.plan, f.web, f.native));
  }
});
test("optional Native MRT must preserve all original HDR bytes", () => {
  const f = setup(); f.native.frames[0].defaultHdrUnchanged = false;
  assert.throws(() => compareNormalAttachments(f.plan, f.web, f.native), /HDR bytes/);
});
test("repeated attachment instability and GPU errors fail", () => {
  const f = setup(); f.native.frames[1].samples[0].hdr[0] = .8;
  assert.throws(() => compareNormalAttachments(f.plan, f.web, f.native), /changed between rounds/);
  const errors = setup(); errors.web.gpuErrors = ["actual validation error"];
  assert.throws(() => validateWebNormalShadow(errors.plan, errors.web));
});
test("missing real occlusion, stale caster shadows and mismatched uploaded uniforms fail", () => {
  for (const mutate of [
    f => f.web.frames.forEach(frame => { frame.samples[0].sampledShadowVisibility = 1; }),
    f => f.web.frames.filter(frame => frame.scenario === "cube-caster-disabled").forEach(frame => { frame.samples[0].sampledShadowVisibility = .5; }),
    f => { f.web.frames[0].shadowUniform[153] = .01; },
  ]) {
    const f = setup(); mutate(f); assert.throws(() => validateWebNormalShadow(f.plan, f.web));
  }
});
