import assert from "node:assert/strict";
import { compareSharedScene } from "./c8SharedSceneParity.mjs";
export const directProfiles = ["three-r185", "single-scatter", "world-normal-single-scatter", "deep-single-scatter"];

export function compareDirectMaterialChain(run, profile) {
  assert(directProfiles.includes(profile), "unknown direct material profile");
  assert.equal(run.profile.directProfile, profile, "wrong actual shader profile");
  assert.deepEqual(run.profile.exposures, [.5], "unregistered material exposure matrix");
  if (Object.hasOwn(run.profile, "hdrAttachmentProfile")) {
    assert.equal(run.profile.hdrAttachmentProfile, "shared-rgba16f", "unknown HDR attachment profile");
    for (const frame of run.frames) for (const backend of ["three", "deep"]) assert.equal(frame[backend].hdrFormat, "rgba16float", "wrong actual HDR attachment format");
  }
  const result = compareSharedScene(run, { exposures: [.5] });
  if (profile === "three-r185") for (const row of result.rows.filter(row => row.stage === "direct-diagnostic")) {
    assert(row.hdrMax <= .002, `full direct HDR drift ${row.hdrMax}`);
    assert(row.byteMax <= 2, `full direct surface drift ${row.byteMax}`);
  }
  return { profile, hdrAttachmentProfile: run.profile.hdrAttachmentProfile ?? "raw-fp32-versus-fp16", ...result, finalDirectStrict: profile === "three-r185", diagnosticOnly: profile !== "three-r185" };
}
