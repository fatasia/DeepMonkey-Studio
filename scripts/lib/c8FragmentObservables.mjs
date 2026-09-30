import assert from "node:assert/strict";

const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function receipt(value, mode) {
  assert.equal(value?.mode, mode, "wrong fragment mode");
  assert(value.deep?.moduleCount > 0 && hash(value.deep.originalHash) && hash(value.deep.instrumentedHash) && value.deep.originalHash !== value.deep.instrumentedHash, "empty actual Deep source receipt");
  assert(value.three?.installCount === 1 && hash(value.three.originalChunkHash) && hash(value.three.instrumentedChunkHash) && value.three.originalChunkHash !== value.three.instrumentedChunkHash, "empty Three source receipt");
  assert(value.three.actualCompiledFragmentHashes?.length > 0 && value.three.actualCompiledFragmentHashes.every(hash) && value.three.compileObservations >= value.three.actualCompiledFragmentHashes.length, "empty actual Three compilation receipt");
}
function frames(run) {
  assert(run.width === 320 && run.height === 192, "wrong frozen fragment extent");
  assert.deepEqual(run.errors, [], "actual draw failed");
  assert.deepEqual(run.profile.exposures, [.5], "wrong fixed exposure");
  assert.equal(run.profile.directProfile, "three-r185", "diagnostic material profile cannot be substituted");
  assert.equal(run.profile.hdrAttachmentProfile, "shared-rgba16f", "actual shared half attachment required");
  const result = run.frames.filter(frame => frame.stage === "direct-diagnostic");
  assert.deepEqual(result.map(frame => frame.camera).sort(), [0, 1], "missing or duplicated actual direct camera");
  for (const frame of result) {
    assert(hash(frame.packetHash) && hash(frame.rootHash) && hash(frame.profileHash), "missing actual author/source identity");
    for (const backend of ["three", "deep"]) {
      const leg = frame[backend];
      assert(leg.rootHash === frame.rootHash && leg.profileHash === frame.profileHash, "mismatched actual input");
      assert(leg.hdrFormat === "rgba16float" && leg.hdr.length === 320 * 192 * 3 && leg.hdr.every(Number.isFinite), "wrong or nonfinite actual attachment");
      assert(leg.drawCalls > 0 && leg.triangles > 1000, "empty production draw");
    }
  }
  return result;
}

/** Certifies observation identity/completeness; numeric differences remain diagnostics. */
export function compareFragmentObservables(captures) {
  assert.deepEqual(captures.map(capture => capture.view).sort(), ["far", "near"], "near/far observation matrix required");
  const rows = [], sourceHashes = new Set(), threeSourceHashes = new Set();
  for (const capture of captures) {
    for (const mode of ["geometry", "single"]) {
      receipt(capture[mode].receipt, mode); sourceHashes.add(capture[mode].receipt.deep.originalHash); threeSourceHashes.add(capture[mode].receipt.three.originalChunkHash);
      const scale = capture.view === "near" ? .6 : 1;
      assert.deepEqual(capture[mode].run.profile.cameras?.map(camera => camera.eye), [[0, 0, 9], [3, 2, 9]].map(eye => eye.map(value => value * scale)), "wrong actual near/far camera profile");
    }
    assert.notEqual(capture.geometry.receipt.deep.instrumentedHash, capture.single.receipt.deep.instrumentedHash, "reused observation module");
    assert.notEqual(capture.geometry.receipt.three.instrumentedChunkHash, capture.single.receipt.three.instrumentedChunkHash, "reused Three observation source");
    const geometry = frames(capture.geometry.run), single = frames(capture.single.run);
    for (const g of geometry) {
      const s = single.find(frame => frame.camera === g.camera);
      assert.equal(s.rootHash, g.rootHash, "changed author root between fragment modes");
      assert.equal(s.profileHash, g.profileHash, "changed author camera/material between fragment modes");
      assert.equal(s.packetHash, g.packetHash, "changed production packet between fragment modes");
      const mask = backend => Array.from({ length: 320 * 192 }, (_, p) => g[backend].hdr[p * 3 + 2] > .01);
      const a = mask("three"), b = mask("deep"), stable = [];
      for (let y = 1; y < 191; y++) for (let x = 1; x < 319; x++) {
        const p = y * 320 + x;
        if ([-1, 0, 1].every(dy => [-1, 0, 1].every(dx => a[p + dy * 320 + dx] && b[p + dy * 320 + dx]))) stable.push(p);
      }
      assert(stable.length >= 1000, "empty actual geometry observation");
      for (const backend of ["three", "deep"]) {
        const roughness = stable.map(p => g[backend].hdr[p * 3 + 2]);
        assert(Math.max(...roughness) - Math.min(...roughness) >= .5, "constant or missing actual material roughness");
        assert(stable.every(p => g[backend].hdr.slice(p * 3, p * 3 + 3).every(v => v >= 0 && v <= 1)), "invalid actual NV/NL/roughness");
        assert(stable.filter(p => Math.max(...s[backend].hdr.slice(p * 3, p * 3 + 3)) > .0001).length >= 1000, "empty actual single light response");
      }
      const metrics = (frame, lane) => {
        const errors = stable.flatMap(p => lane === undefined ? [0, 1, 2].map(k => Math.abs(frame.three.hdr[p * 3 + k] - frame.deep.hdr[p * 3 + k])) : [Math.abs(frame.three.hdr[p * 3 + lane] - frame.deep.hdr[p * 3 + lane])]).sort((x, y) => x - y);
        return { max: errors.at(-1), p99: errors[Math.floor(errors.length * .99)], rmse: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length) };
      };
      rows.push({ view: capture.view, camera: g.camera, stableInterior: stable.length, nv: metrics(g, 0), nl: metrics(g, 1), roughness: metrics(g, 2), single: metrics(s) });
    }
  }
  assert.equal(sourceHashes.size, 1, "changed production source during observation matrix");
  assert.equal(threeSourceHashes.size, 1, "changed Three input source during observation matrix");
  return { passed: true, qualityCertified: false, scope: "actual fragment observables only; S5 HDR/display gate unchanged", rows };
}
