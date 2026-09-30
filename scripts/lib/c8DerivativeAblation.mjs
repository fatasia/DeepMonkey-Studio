import assert from "node:assert/strict";
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const errors = values => { values.sort((a, b) => a - b); return { max: values.at(-1), p99: values[Math.floor(values.length * .99)], rmse: Math.sqrt(values.reduce((sum, e) => sum + e * e, 0) / values.length) }; };

/** Certifies actual candidate identity and observation completeness, not final HDR quality. */
export function compareDerivativeAblation(captures) {
  assert.deepEqual(captures.map(c => c.derivative).sort(), ["coarse", "fine"], "two explicit derivative candidates required");
  const rows = [], originals = new Set(), instrumented = new Set(), three = new Set();
  for (const capture of captures) {
    const { run, receipt } = capture;
    assert(receipt.mode === "rough-single" && receipt.derivative === capture.derivative && receipt.threeDerivative === "default", "wrong actual derivative observation policy");
    assert(receipt.deep.moduleCount > 0 && hash(receipt.deep.originalHash) && hash(receipt.deep.instrumentedHash) && receipt.deep.originalHash !== receipt.deep.instrumentedHash, "empty actual Deep receipt");
    assert(receipt.three.installCount === 1 && hash(receipt.three.originalChunkHash) && hash(receipt.three.instrumentedChunkHash) && receipt.three.originalChunkHash !== receipt.three.instrumentedChunkHash, "empty actual Three receipt");
    assert(receipt.three.actualCompiledFragmentHashes.length > 0 && receipt.three.actualCompiledFragmentHashes.every(hash) && receipt.three.compileObservations >= receipt.three.actualCompiledFragmentHashes.length, "missing actual GL compile");
    originals.add(receipt.deep.originalHash); instrumented.add(receipt.deep.instrumentedHash); three.add(receipt.three.instrumentedChunkHash);
    assert(run.width === 320 && run.height === 192 && run.errors.length === 0, "wrong or failed actual frame");
    assert.deepEqual(run.profile.exposures, [.5], "changed fixed exposure");
    assert(run.profile.directProfile === "three-r185" && run.profile.hdrAttachmentProfile === "shared-rgba16f", "changed Three/attachment profile");
    assert.deepEqual(run.profile.cameras.map(c => c.eye), [[0, 0, 9], [3, 2, 9]], "far front/oblique control required");
    const frames = run.frames.filter(f => f.stage === "direct-diagnostic");
    assert.deepEqual(frames.map(f => f.camera).sort(), [0, 1], "missing or reused camera");
    for (const frame of frames) {
      assert(hash(frame.rootHash) && hash(frame.packetHash) && hash(frame.profileHash), "missing shared author identity");
      for (const backend of ["three", "deep"]) {
        const leg = frame[backend];
        assert(leg.rootHash === frame.rootHash && leg.profileHash === frame.profileHash, "changed author input");
        assert(leg.drawCalls > 0 && leg.triangles > 1000 && leg.hdrFormat === "rgba16float" && leg.hdr.length === 320 * 192 * 3 && leg.hdr.every(Number.isFinite), "empty or invalid production attachment");
      }
      const stable = [], covered = p => frame.three.hdr[p * 3] > .01 && frame.deep.hdr[p * 3] > .01;
      for (let y = 1; y < 191; y++) for (let x = 1; x < 319; x++) { const p = y * 320 + x; if ([-1, 0, 1].every(dy => [-1, 0, 1].every(dx => covered(p + dy * 320 + dx)))) stable.push(p); }
      assert(stable.length >= 1000, "empty actual geometry");
      for (const backend of ["three", "deep"]) {
        const rough = stable.map(p => frame[backend].hdr[p * 3]);
        assert(rough.every(v => v >= 0 && v <= 1) && Math.max(...rough) - Math.min(...rough) >= .5, "missing actual material roughness");
        assert(stable.filter(p => Math.max(...frame[backend].hdr.slice(p * 3 + 1, p * 3 + 3)) > .0001).length >= 1000, "missing actual single contribution");
      }
      rows.push({ derivative: capture.derivative, camera: frame.camera, stableInterior: stable.length,
        roughness: errors(stable.map(p => Math.abs(frame.three.hdr[p * 3] - frame.deep.hdr[p * 3]))),
        singleRG: errors(stable.flatMap(p => [1, 2].map(k => Math.abs(frame.three.hdr[p * 3 + k] - frame.deep.hdr[p * 3 + k])))) });
    }
  }
  assert(originals.size === 1 && instrumented.size === 2 && three.size === 1, "reused candidate or changed default Three control");
  const a = captures[0].run.frames.filter(f => f.stage === "direct-diagnostic"), b = captures[1].run.frames.filter(f => f.stage === "direct-diagnostic");
  for (const frame of a) { const other = b.find(f => f.camera === frame.camera); assert(frame.rootHash === other.rootHash && frame.packetHash === other.packetHash && frame.profileHash === other.profileHash, "changed input between derivative candidates"); assert.deepEqual(frame.three.hdr, other.three.hdr, "default Three control drifted"); }
  return { passed: true, qualityCertified: false, rows, scope: "isolated Deep fine/coarse versus original Three default; product HDR/display gate unchanged" };
}
