import assert from "node:assert/strict";
const modes = ["view-normal", "abs-dx", "abs-dy"], hash = s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const tolerance = .0025;
const normal = (frame, backend, p) => frame[backend].hdr.slice(p * 3, p * 3 + 3).map(v => v * 2 - 1);
const vector = (frame, backend, p) => frame[backend].hdr.slice(p * 3, p * 3 + 3);
const delta = (a, b) => a.map((v, k) => Math.abs(v - b[k]));
const distance = (a, b) => Math.max(...delta(a, b));
const metrics = values => { values.sort((a, b) => a - b); return { max: values.at(-1), p99: values[Math.floor(values.length * .99)], rmse: Math.sqrt(values.reduce((s, e) => s + e * e, 0) / values.length) }; };

export function compareDerivativeVectors(captures) {
  assert.deepEqual(captures.map(c => c.mode).sort(), [...modes].sort(), "complete normal/dx/dy observation matrix required");
  const original = new Set(), instrumented = new Set(), threeOriginal = new Set(), threeInstrumented = new Set(), matrix = {};
  for (const capture of captures) {
    const { receipt: r, run } = capture;
    assert(r.mode === capture.mode && r.derivative === "default" && r.threeDerivative === "default", "actual default operators required");
    assert(r.deep.moduleCount > 0 && hash(r.deep.originalHash) && hash(r.deep.instrumentedHash) && r.deep.originalHash !== r.deep.instrumentedHash, "missing actual Deep source receipt");
    assert(r.three.installCount === 1 && hash(r.three.originalChunkHash) && hash(r.three.instrumentedChunkHash) && r.three.originalChunkHash !== r.three.instrumentedChunkHash, "missing Three source receipt");
    assert(r.three.actualCompiledFragmentHashes?.length > 0 && r.three.actualCompiledFragmentHashes.every(hash) && r.three.compileObservations >= r.three.actualCompiledFragmentHashes.length, "missing actual GL compile");
    original.add(r.deep.originalHash); instrumented.add(r.deep.instrumentedHash); threeOriginal.add(r.three.originalChunkHash); threeInstrumented.add(r.three.instrumentedChunkHash);
    assert(run.width === 320 && run.height === 192 && run.errors.length === 0, "wrong actual frame extent or draw error");
    assert.deepEqual(run.profile.exposures, [.5], "fixed exposure changed");
    assert(run.profile.directProfile === "three-r185" && run.profile.hdrAttachmentProfile === "shared-rgba16f", "original material/attachment required");
    assert.deepEqual(run.profile.cameras.map(c => c.eye), [[0, 0, 9], [3, 2, 9]], "far front/oblique required");
    const frames = run.frames.filter(f => f.stage === "direct-diagnostic"); assert.deepEqual(frames.map(f => f.camera).sort(), [0, 1], "missing or duplicated camera");
    for (const f of frames) for (const backend of ["three", "deep"]) {
      const leg = f[backend]; assert(hash(f.rootHash) && hash(f.packetHash) && hash(f.profileHash) && leg.rootHash === f.rootHash && leg.profileHash === f.profileHash, "changed shared author input");
      assert(leg.hdrFormat === "rgba16float" && leg.hdr.length === 320 * 192 * 3 && leg.hdr.every(Number.isFinite) && leg.drawCalls > 0 && leg.triangles > 1000, "empty or nonfinite actual attachment");
    }
    matrix[capture.mode] = frames;
  }
  assert(original.size === 1 && threeOriginal.size === 1 && instrumented.size === 3 && threeInstrumented.size === 3, "drifted original or reused observation source");
  const rows = [];
  for (const n of matrix["view-normal"]) {
    const dx = matrix["abs-dx"].find(f => f.camera === n.camera), dy = matrix["abs-dy"].find(f => f.camera === n.camera);
    for (const f of [dx, dy]) assert(f.rootHash === n.rootHash && f.packetHash === n.packetHash && f.profileHash === n.profileHash, "changed packet between vector observations");
    const covered = backend => Array.from({ length: 320 * 192 }, (_, p) => n[backend].hdr.slice(p * 3, p * 3 + 3).some(v => v > .01));
    const a = covered("three"), b = covered("deep"), stable = [], inside = p => a[p] && b[p];
    for (let y = 1; y < 191; y++) for (let x = 1; x < 319; x++) { const p = y * 320 + x; if ([-1, 0, 1].every(oy => [-1, 0, 1].every(ox => inside(p + oy * 320 + ox)))) stable.push(p); }
    assert(stable.length >= 1000, "missing actual normal geometry");
    for (const backend of ["three", "deep"]) {
      assert(stable.every(p => { const v = normal(n, backend, p); return v.every(k => k >= -1 && k <= 1) && Math.abs(Math.hypot(...v) - 1) <= .003; }), "invalid actual unit view-normal");
      for (const f of [dx, dy]) {
        assert(stable.every(p => vector(f, backend, p).every(v => v >= 0 && v <= 2)), "invalid actual absolute derivative");
        assert(stable.filter(p => Math.max(...vector(f, backend, p)) > .0001).length >= 1000, "missing actual derivative signal");
      }
    }
    const field = f => metrics(stable.flatMap(p => delta(vector(f, "three", p), vector(f, "deep", p))));
    const normals = metrics(stable.flatMap(p => delta(normal(n, "three", p), normal(n, "deep", p))));
    const stableSet = new Set(stable), relation = {};
    for (const backend of ["three", "deep"]) {
      const axes = [dx, dy].map((f, axis) => {
        let quads = 0, matchingQuads = 0; const selections = { first: 0, second: 0, both: 0, neither: 0 };
        for (let y = 2; y < 190; y += 2) for (let x = 2; x < 318; x += 2) {
          const p = y * 320 + x, indices = [p, p + 1, p + 320, p + 321]; if (!indices.every(k => stableSet.has(k))) continue; quads++;
          const v = indices.map(k => normal(n, backend, k)), candidates = axis === 0 ? [delta(v[0], v[1]), delta(v[2], v[3])] : [delta(v[0], v[2]), delta(v[1], v[3])];
          let full = true;
          for (const k of indices) { const observed = vector(f, backend, k), first = distance(observed, candidates[0]) <= tolerance, second = distance(observed, candidates[1]) <= tolerance;
            selections[first && second ? "both" : first ? "first" : second ? "second" : "neither"]++; if (!first && !second) full = false; }
          if (full) matchingQuads++;
        }
        assert(quads >= 128, "missing complete normal quads");
        return { axis: axis === 0 ? "dx" : "dy", quads, matchingQuads, matchRate: matchingQuads / quads, selections };
      }); relation[backend] = axes;
    }
    const explained = normals.p99 <= tolerance && Object.values(relation).flat().every(axis => axis.matchRate >= .95);
    rows.push({ camera: n.camera, stableInterior: stable.length, normal: normals, dx: field(dx), dy: field(dy), relation,
      classification: explained ? "compatible with normal local derivative differences" : "unexplained derivative residue" });
  }
  return { passed: true, qualityCertified: false, tolerance, rows, scope: "actual default normal/derivative vectors; original S5 HDR/display gate unchanged" };
}
