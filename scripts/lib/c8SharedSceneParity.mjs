import assert from "node:assert/strict";

export function compareSharedScene(run, options = {}) {
  assert(options && typeof options === "object" && !Array.isArray(options) && Object.keys(options).every(key => key === "exposures"), "invalid comparison options");
  const exposures = Object.hasOwn(options, "exposures") ? options.exposures : [.5, 2];
  assert(Array.isArray(exposures) && exposures.length > 0 && exposures.every(value => value === .5 || value === 2) && new Set(exposures).size === exposures.length, "invalid registered exposures");
  const { width, height, frames } = run;
  assert(Number.isInteger(width) && Number.isInteger(height) && width >= 3 && height >= 3, "invalid extent");
  assert.equal(frames.length, 4 * exposures.length, "full stage/camera/exposure matrix required"); assert.deepEqual(run.errors, []);
  assert.equal(new Set(frames.map(frame => frame.name)).size, frames.length, "duplicate frame identity");
  const keys = frames.map(frame => `${frame.stage}/${frame.camera}/${frame.exposure}`).sort();
  const expected = ["strict-emissive", "direct-diagnostic"].flatMap(stage => [0, 1].flatMap(camera => exposures.map(exposure => `${stage}/${camera}/${exposure}`))).sort();
  assert.deepEqual(keys, expected, "incomplete or repeated stage/camera/exposure matrix");
  const mask = hdr => Array.from({ length: width * height }, (_, pixel) => Math.max(...hdr.slice(pixel * 3, pixel * 3 + 3)) > .004);
  function boundary(bits, x, y) {
    const own = bits[y * width + x];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < width && yy < height && bits[yy * width + xx] !== own) return true;
    }
    return false;
  }
  function nearBoundary(bits, x, y) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height && boundary(bits, x + dx, y + dy)) return true;
    }
    return false;
  }
  const rows = [];
  for (const frame of frames) {
    assert(["strict-emissive", "direct-diagnostic"].includes(frame.stage));
    assert(/^[a-f0-9]{64}$/.test(frame.rootHash) && /^[a-f0-9]{64}$/.test(frame.packetHash) && /^[a-f0-9]{64}$/.test(frame.profileHash), "source identity missing");
    for (const host of ["three", "deep"]) {
      const leg = frame[host];
      assert.equal(leg.rootHash, frame.rootHash, "author root identity drift"); assert.equal(leg.profileHash, frame.profileHash, "profile identity drift");
      assert.equal(leg.hdr.length, width * height * 3, "HDR extent drift"); assert.equal(leg.display.length, width * height * 4, "surface extent drift");
      assert(leg.hdr.every(value => Number.isFinite(value) && value >= -1e-6), "non-finite or negative HDR");
      assert(leg.display.every(value => Number.isInteger(value) && value >= 0 && value <= 255), "invalid display lane");
      assert(leg.drawCalls >= (host === "three" ? 6 : 2) && leg.triangles >= 1000, "actual geometry draw missing");
      assert(leg.hdr.slice(0, 3).every(value => Math.abs(value) <= .001), "HDR corner must be black");
      assert(leg.display.slice(0, 3).every(value => value === 0), "surface corner must be black");
    }
    const a = mask(frame.three.hdr), b = mask(frame.deep.hdr);
    assert(a.filter(Boolean).length >= 1000 && b.filter(Boolean).length >= 1000, `empty geometry frame ${frame.name}: three=${a.filter(Boolean).length}, deep=${b.filter(Boolean).length}`);
    let stableInterior = 0, maskMismatch = 0, hdrMax = 0, byteMax = 0, hdrSquared = 0;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const pixel = y * width + x;
      if (a[pixel] !== b[pixel]) {
        maskMismatch++; assert(nearBoundary(a, x, y) && nearBoundary(b, x, y), "geometry mismatch outside both actual 1px boundaries");
      }
      if (!a[pixel] || !b[pixel] || boundary(a, x, y) || boundary(b, x, y)) continue;
      stableInterior++;
      for (let lane = 0; lane < 3; lane++) {
        const error = Math.abs(frame.three.hdr[pixel * 3 + lane] - frame.deep.hdr[pixel * 3 + lane]);
        hdrMax = Math.max(hdrMax, error); hdrSquared += error * error;
      }
      for (let lane = 0; lane < 4; lane++) byteMax = Math.max(byteMax, Math.abs(frame.three.display[pixel * 4 + lane] - frame.deep.display[pixel * 4 + lane]));
    }
    assert(stableInterior >= 1000, "insufficient stable interior");
    if (frame.stage === "strict-emissive") { assert(hdrMax <= .002, `strict emissive HDR drift ${hdrMax}`); assert(byteMax <= 2, `strict output profile drift ${byteMax}`); }
    const contributions = {};
    if (frame.stage === "direct-diagnostic") {
      const dark = frames.find(candidate => candidate.stage === "strict-emissive" && candidate.camera === frame.camera && candidate.exposure === frame.exposure);
      assert(dark, "missing real lights-off baseline");
      for (const host of ["three", "deep"]) {
        let covered = 0;
        for (let pixel = 0; pixel < width * height; pixel++) if ([0, 1, 2].some(lane => frame[host].hdr[pixel * 3 + lane] - dark[host].hdr[pixel * 3 + lane] > .002)) covered++;
        assert(covered >= 1000, `${host} missing real direct light contribution`); contributions[host] = covered;
      }
    }
    rows.push({ name: frame.name, stage: frame.stage, stableInterior, maskMismatch, hdrMax, hdrRmse: Math.sqrt(hdrSquared / (stableInterior * 3)), byteMax, contributions });
  }
  return { passed: true, strictScope: "same author root, emissive HDR and actual ACES output", diagnosticScope: "direct BRDF differences retained", rows };
}
