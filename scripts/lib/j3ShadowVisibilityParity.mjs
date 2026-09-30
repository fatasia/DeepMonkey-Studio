import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { intersectShadowVisibility, shadowVisibilityInterval } from "./j3ShadowVisibilityIntervals.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function decodeShadowUniform(raw, native) {
  assert.equal(raw.length, native ? 84 : 156, "actual host shadow ABI length mismatch");
  assert(raw.every(Number.isFinite));
  const matrixCount = native ? 4 : 8, splitOffset = native ? 64 : 128;
  const blendOffset = native ? 68 : 136, texelOffset = native ? 72 : 144, params = native ? 76 : 152;
  return { matrices: Array.from({ length: matrixCount }, (_, index) => raw.slice(index * 16, index * 16 + 16)),
    splits: raw.slice(splitOffset, splitOffset + matrixCount), blendStarts: raw.slice(blendOffset, blendOffset + matrixCount),
    texelWorld: raw.slice(texelOffset, texelOffset + matrixCount), count: raw[params], bias: raw[params + 1], inverseMapSize: raw[params + 2] };
}
function frame(host, cameraId, cascadeCount, scenario, round) {
  const rows = host.frames.filter(row => row.cameraId === cameraId && row.cascadeCount === cascadeCount && row.scenario === scenario && row.round === round);
  assert.equal(rows.length, 1, "exactly one actual frame per camera/profile/scenario/round required"); return rows[0];
}
function masks(row, points) {
  assert.deepEqual(row.samples.map(sample => [sample.pixel, sample.instanceId]), points.map(point => [point.pixel, point.instanceId]), "all fixed 85 masks must remain unchanged");
}

export function compareShadowVisibility(plan, web, native) {
  for (const host of [web, native]) {
    assert.equal(host.packageHash, plan.packageHash); assert.equal(host.packetHash, plan.packetHash);
    assert.equal(host.width, plan.width); assert.equal(host.height, plan.height); assert.deepEqual(host.gpuErrors, []);
  }
  assert.equal(web.frames.length, 24); assert.equal(native.frames.length, 16);
  const cases = [], differences = [];
  let maxGap = 0, pointsCompared = 0;
  const cameraIds = [...new Set(plan.cases.map(row => row.cameraId))];
  for (const cameraId of cameraIds) for (const cascadeCount of [4]) {
    const points = plan.cases.filter(row => row.cameraId === cameraId && row.cascadeCount === cascadeCount)
      .flatMap(row => row.points.map(point => ({ ...point, instanceId: row.instanceId })));
    const rounds = [];
    for (const round of [0, 1]) {
      const w = frame(web, cameraId, cascadeCount, "baseline", round);
      const wc = frame(web, cameraId, cascadeCount, "triangle-receiver-disabled", round);
      const n = frame(native, cameraId, cascadeCount, "baseline", round);
      const nc = frame(native, cameraId, cascadeCount, "unshadowed-control", round);
      for (const row of [w, wc, n, nc]) masks(row, points);
      assert.equal(w.expectedVP.length, 16);
      for (const row of [w, wc, n, nc]) {
        assert.equal(row.actualVP.length, 16);
        assert(row.actualVP.every((value, lane) => Number.isFinite(value) && Math.abs(value - w.expectedVP[lane]) < 1e-5), "actual camera VP differs between the common shadow frames");
      }
      const wu = decodeShadowUniform(w.shadowUniform, false), nu = decodeShadowUniform(n.shadowUniform, true);
      for (const uniform of [wu, nu]) {
        assert.equal(uniform.count, cascadeCount); assert(Math.abs(uniform.bias - plan.profile.depthBias) < 1e-8);
        assert.equal(uniform.inverseMapSize, 1 / plan.profile.shadowMapSize);
        assert(Math.abs(uniform.splits[cascadeCount - 1] - plan.profile.maxShadowDistance) < 1e-5);
        assert(uniform.splits.slice(0, cascadeCount).every((value, lane) => Math.abs(value - uniform.blendStarts[lane]) < 1e-5), "common profile requires blend=0");
      }
      assert.equal(hash(n.shadowUniform), hash(nc.shadowUniform), "control changed actual Native shadow matrices");
      assert.equal(n.shadowMapHash, nc.shadowMapHash, "control changed actual production Native shadow map");
      assert.match(n.shadowMapHash, /^[0-9a-f]{64}$/); assert(n.shadowMapNonClear > 0);
      assert.equal(n.shadowMapSamples, cascadeCount * plan.profile.shadowMapSize ** 2);
      assert.equal(n.lighting.shadows, 1); assert.equal(nc.lighting.shadows, 0);
      for (const row of [n, nc]) {
        assert.equal(row.lighting.environment, 0); assert.equal(row.lighting.exposure, 1); assert.equal(row.lighting.localLights, 0);
        assert.equal(row.lighting.authoredMode, 2);
        assert(row.lighting.direction.length === 3 && row.lighting.direction.every((value, lane) => Math.abs(value - plan.profile.surfaceToLight[lane]) < 1e-6));
        assert(row.lighting.radiance.length === 3 && row.lighting.radiance.every((value, lane) => Math.abs(value - [2.5, 2.4, 2.25][lane]) < 1e-6));
      }
      const samples = points.map((point, index) => {
        const webVisibility = shadowVisibilityInterval(w.samples[index].hdr, wc.samples[index].hdr);
        const nativeVisibility = shadowVisibilityInterval(n.samples[index].hdr, nc.samples[index].hdr);
        const comparison = intersectShadowVisibility(webVisibility, nativeVisibility); maxGap = Math.max(maxGap, comparison.gap);
        if (!comparison.overlaps) differences.push({ cameraId, cascadeCount, round, pixel: point.pixel, instanceId: point.instanceId,
          geometricOccluded: point.baselineOccluded, web: webVisibility, native: nativeVisibility, gap: comparison.gap });
        return { pixel: point.pixel, instanceId: point.instanceId, geometricOccluded: point.baselineOccluded,
          web: webVisibility, native: nativeVisibility, ...comparison };
      });
      rounds.push(samples); pointsCompared += samples.length;
      if (round === 1) {
        for (const [host, scenario] of [[web, "baseline"], [web, "triangle-receiver-disabled"], [native, "baseline"], [native, "unshadowed-control"]]) {
          const previous = frame(host, cameraId, cascadeCount, scenario, 0), current = frame(host, cameraId, cascadeCount, scenario, 1);
          assert.equal(hash(previous.samples), hash(current.samples), "actual HDR changed on repeated draws");
          assert.equal(hash(previous.shadowUniform), hash(current.shadowUniform), "actual shadow upload changed on repeated draws");
        }
      }
    }
    cases.push({ cameraId, cascadeCount, samples: rounds[0], stable: hash(rounds[0]) === hash(rounds[1]) });
  }
  assert.equal(pointsCompared, 170, "same 85 points times common four-cascade profile and two rounds required");
  return { passed: differences.length === 0, stable: cases.every(row => row.stable), currentRun: false,
    scope: "actual production HDR shadow visibility / matched unshadowed control at all fixed 85 points",
    maxVisibilityIntervalGap: maxGap, pointsCompared, differences, cases,
    uniformMatricesMustMatch: false, visibilityBudget: "binary16-neighbour-midpoints-plus-one-f32-multiply",
    unpairedDiagnostics: { native: "legal two-cascade actual frames retained in native.json", web: "legal one-cascade actual frames retained in web.json" },
    excluded: ["identical CSM depth-fit matrices", "Native two / Web one cascade parity", "normal-map/smooth/transparent shadow profiles"] };
}
