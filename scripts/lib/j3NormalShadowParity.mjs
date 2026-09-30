import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// UNORM8 encoded normals have decoded component half-step 1/255.
export const NORMAL_QUANTIZATION_ANGLE = Math.asin(Math.sqrt(3) / 255) * 180 / Math.PI;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unit = values => { const length = Math.hypot(...values); assert(length > 0 && Number.isFinite(length)); return values.map(value => value / length); };
function decode(encoded) {
  assert.equal(encoded.length, 4); assert(encoded.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  return unit(encoded.slice(0, 3).map(value => value * 2 - 1));
}
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, value, lane) => sum + value * b[lane], 0)))) * 180 / Math.PI;
function identity(plan, host) {
  assert.equal(host.packageHash, plan.packageHash); assert.equal(host.packetHash, plan.packetHash);
  assert.equal(host.width, plan.width); assert.equal(host.height, plan.height);
  assert.equal(host.actualNormalAttachments, true); assert.deepEqual(host.gpuErrors, []);
}
function expected(plan, cameraId, cascadeCount = 1) {
  return plan.cases.filter(row => row.cameraId === cameraId && row.cascadeCount === cascadeCount)
    .flatMap(row => row.points.map(point => ({ ...point, instanceId: row.instanceId })));
}
function masks(points, samples) {
  assert.equal(samples.length, points.length, "all preregistered points required");
  assert.deepEqual(samples.map(sample => [sample.pixel, sample.instanceId]), points.map(point => [point.pixel, point.instanceId]), "fixed masks cannot be filtered by observed similarity");
}
function stable(frames) {
  const rows = new Map();
  for (const frame of frames) {
    const id = `${frame.cameraId}/${frame.cascadeCount ?? "normal"}/${frame.scenario ?? "normal"}`;
    const row = rows.get(id) ?? []; row.push(frame); rows.set(id, row);
  }
  for (const row of rows.values()) {
    assert.deepEqual(row.map(frame => frame.round), [0, 1], "two fresh draws per case required");
    assert.equal(hash(row[0].samples), hash(row[1].samples), "actual normal/HDR/shadow samples changed between rounds");
    if (row[0].shadowUniform) assert.equal(hash(row[0].shadowUniform), hash(row[1].shadowUniform), "actual shadow uniform changed between rounds");
  }
}

export function validateWebNormalShadow(plan, web) {
  identity(plan, web); assert.equal(web.normalAttachment, "production-view-normal-rgba8unorm");
  assert.equal(web.frames.length, 24); stable(web.frames);
  let maxNormalAngle = 0, darkest = 1;
  for (const frame of web.frames) {
    assert([1, 4].includes(frame.cascadeCount)); assert(["baseline", "cube-caster-disabled", "triangle-receiver-disabled"].includes(frame.scenario));
    const points = expected(plan, frame.cameraId, frame.cascadeCount); masks(points, frame.samples);
    assert.equal(frame.actualWorldToView.length, 16); assert(frame.actualWorldToView.every(Number.isFinite));
    assert.equal(frame.actualVP.length, 16); assert.equal(frame.expectedVP.length, 16);
    assert(frame.actualVP.every((value, lane) => Math.abs(value - frame.expectedVP[lane]) < 1e-5), "actual VP differs from official authored camera math");
    assert.equal(frame.shadowUniform.length, 156); assert(frame.shadowUniform.every(Number.isFinite));
    assert.equal(frame.shadowUniform[152], frame.cascadeCount);
    assert(Math.abs(frame.shadowUniform[153] - plan.profile.depthBias) < 1e-8);
    assert.equal(frame.shadowUniform[154], 1 / plan.profile.shadowMapSize);
    assert(Math.abs(frame.shadowUniform[128 + frame.cascadeCount - 1] - plan.profile.maxShadowDistance) < 1e-5);
    frame.samples.forEach((sample, index) => {
      const error = angle(decode(sample.encodedViewNormal), points[index].expectedViewNormal);
      assert(error <= NORMAL_QUANTIZATION_ANGLE + .01, "actual view normal exceeds quantization budget"); maxNormalAngle = Math.max(maxNormalAngle, error);
      assert(sample.hdr.length === 3 && sample.hdr.every(Number.isFinite)); assert(Number.isFinite(sample.linearDepth) && sample.linearDepth > 0);
      assert(Number.isFinite(sample.sampledShadowVisibility) && sample.sampledShadowVisibility >= 0 && sample.sampledShadowVisibility <= 1);
      if (frame.scenario === "baseline") darkest = Math.min(darkest, sample.sampledShadowVisibility);
      if (frame.scenario === "cube-caster-disabled") assert(sample.sampledShadowVisibility >= .999, "disabled cube caster left a shadow on the common triangles");
    });
  }
  assert(darkest < .95, "actual production shadow map contains no common cube-to-triangle occlusion");
  return { passed: true, stable: true, maxNormalAngleDegrees: maxNormalAngle, darkestSampledShadowVisibility: darkest,
    scope: "actual Web normal attachment and production shadow map/uniform observation", shadowParity: false };
}

export function compareNormalAttachments(plan, web, native) {
  const webResult = validateWebNormalShadow(plan, web); identity(plan, native);
  assert.equal(native.normalAttachment, "production-world-normal-rgba8unorm"); assert.equal(native.frames.length, 4); stable(native.frames);
  let maxWorldAngle = 0, maxNativeOracleAngle = 0;
  for (const frame of native.frames) {
    assert.equal(frame.defaultHdrUnchanged, true, "Native optional MRT must preserve all default HDR bytes");
    const points = expected(plan, frame.cameraId); masks(points, frame.samples);
    const other = web.frames.find(value => value.cameraId === frame.cameraId && value.cascadeCount === 4 && value.scenario === "baseline" && value.round === frame.round);
    assert(other, "matching actual Web camera/round required");
    assert(frame.actualVP.every((value, lane) => Math.abs(value - other.expectedVP[lane]) < 1e-5));
    frame.samples.forEach((sample, index) => {
      const normal = decode(sample.encodedWorldNormal), oracleError = angle(normal, points[index].expectedWorldNormal);
      assert(oracleError <= NORMAL_QUANTIZATION_ANGLE + .01); maxNativeOracleAngle = Math.max(maxNativeOracleAngle, oracleError);
      const viewNormal = decode(other.samples[index].encodedViewNormal), view = other.actualWorldToView;
      const worldNormal = unit([0, 1, 2].map(axis => view[axis * 4] * viewNormal[0] + view[axis * 4 + 1] * viewNormal[1] + view[axis * 4 + 2] * viewNormal[2]));
      const error = angle(normal, worldNormal);
      assert(error <= 2 * NORMAL_QUANTIZATION_ANGLE + .01, "actual dual normal angle exceeds two attachment quantization budgets");
      maxWorldAngle = Math.max(maxWorldAngle, error);
      assert(Math.abs(sample.encodedWorldNormal[3] - other.samples[index].encodedViewNormal[3]) <= 1 / 255 + 1e-6, "normal roughness alpha differs");
    });
  }
  return { passed: true, stable: true, normalParity: true, shadowParity: false,
    maxWorldNormalAngleDegrees: maxWorldAngle, maxNativeOracleAngleDegrees: maxNativeOracleAngle, web: webResult,
    scope: "actual production normal attachments on the same 85 flat-triangle points", excluded: ["shadow matrix parity", "HDR radiance parity for the shadow scenario", "normal-map and smooth geometry"] };
}
