import assert from "node:assert/strict";
import { compareSharedScene } from "./c8SharedSceneParity.mjs";

export const localDirectCases = ["point-only", "spot-only", "secondary-directional"];
export function compareLocalDirect(captures) {
  assert.equal(captures.length, 6, "full local fixture/profile matrix required");
  assert.deepEqual(captures.map(item => `${item.kind}/${item.profile}`).sort(), localDirectCases.flatMap(kind =>
    ["formal", "single-scatter-ablation"].map(profile => `${kind}/${profile}`)).sort(), "missing or repeated local case");
  const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const original = captures[0].receipt.originalHash, rows = [];
  let qualityCertified = true;
  for (const item of captures) {
    assert.equal(item.run.profile.directProfile, "three-r185", "original Three baseline required");
    assert.deepEqual(item.run.profile.exposures, [.5], "registered exposure required");
    assert.equal(item.run.profile.hdrAttachmentProfile, "shared-rgba16f", "actual common FP16 attachment required");
    for (const frame of item.run.frames) for (const host of ["three", "deep"]) assert.equal(frame[host].hdrFormat, "rgba16float");
    const receipt = item.receipt;
    assert(hash(original) && hash(receipt.actualHash)); assert.equal(receipt.originalHash, original, "production source drift");
    assert.equal(receipt.moduleCount, 1, "actual production module missing or repeated");
    assert(receipt.threeCompiledHashes.length > 0 && receipt.threeCompiledHashes.every(hash) && receipt.threeObservations > 0, "actual Three program missing");
    assert.equal(receipt.actualHash === original, item.profile === "formal", "wrong actual shader profile");
    assert.equal(item.lighting.primary.intensity, 0, "local-only primary must be off");
    const lights = item.kind === "point-only" ? item.lighting.clustered.points : item.kind === "spot-only" ? item.lighting.clustered.spots : item.lighting.clustered.directional;
    assert.equal(lights.length, 1); assert(lights[0].intensity > 0, "real local light absent");
    const checked = compareSharedScene(item.run, { exposures: [.5] });
    if (item.profile !== "formal") continue;
    const legacy = captures.find(candidate => candidate.kind === item.kind && candidate.profile === "single-scatter-ablation");
    for (const row of checked.rows.filter(row => row.stage === "direct-diagnostic")) {
      const frame = item.run.frames.find(frame => frame.name === row.name), old = legacy.run.frames.find(frame => frame.name === row.name);
      assert.equal(frame.rootHash, old.rootHash); assert.equal(frame.packetHash, old.packetHash); assert.equal(frame.profileHash, old.profileHash);
      assert.deepEqual(frame.three, old.three, "Three baseline changed during ablation");
      let affected = 0, maxAdded = 0;
      for (let pixel = 0; pixel < item.run.width * item.run.height; pixel++) {
        let added = 0;
        for (let lane = 0; lane < 3; lane++) added = Math.max(added, frame.deep.hdr[pixel * 3 + lane] - old.deep.hdr[pixel * 3 + lane]);
        if (added > 1e-6) affected++; maxAdded = Math.max(maxAdded, added);
      }
      assert(affected >= 1000, "canonical local multiscattering contribution missing");
      const strict = row.hdrMax <= .002 && row.byteMax <= 2; qualityCertified &&= strict;
      rows.push({ kind: item.kind, ...row, affected, maxAdded, strict });
    }
  }
  return { passed: true, qualityCertified, rows, scope: "formal local multiscattering consumption; original Three direct quality separately reported" };
}
