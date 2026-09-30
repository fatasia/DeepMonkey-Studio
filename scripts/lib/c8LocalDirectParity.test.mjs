import { test } from "node:test";
import assert from "node:assert/strict";
import { compareLocalDirect, localDirectCases } from "./c8LocalDirectParity.mjs";
const h = "a".repeat(64), modified = "b".repeat(64);
function fixture() {
  return localDirectCases.flatMap(kind => ["formal", "single-scatter-ablation"].map(profile => {
    const frames = ["strict-emissive", "direct-diagnostic"].flatMap(stage => [0, 1].map(camera => {
      const leg = host => {
        const hdr = Array(64 * 40 * 3).fill(0), display = Array(64 * 40 * 4).fill(0);
        for (let y = 5; y < 35; y++) for (let x = 8; x < 56; x++) {
          const p = y * 64 + x;
          for (let lane = 0; lane < 3; lane++) {
            hdr[p * 3 + lane] = stage === "strict-emissive" ? .1 : host === "three" || profile === "formal" ? .201 : .2;
            display[p * 4 + lane] = stage === "strict-emissive" ? 32 : 50;
          }
          display[p * 4 + 3] = 255;
        }
        return { hdr, display, hdrFormat: "rgba16float", rootHash: h, profileHash: h, drawCalls: 6, triangles: 2196 };
      };
      return { name: `${stage}/${camera}`, stage, camera, exposure: .5, rootHash: h, packetHash: h, profileHash: h, three: leg("three"), deep: leg("deep") };
    }));
    const key = kind === "point-only" ? "points" : kind === "spot-only" ? "spots" : "directional";
    return { kind, profile, lighting: { primary: { intensity: 0 }, clustered: { [key]: [{ intensity: 120 }] } },
      receipt: { originalHash: h, actualHash: profile === "formal" ? h : modified, moduleCount: 1, threeCompiledHashes: [h], threeObservations: 4 },
      run: { width: 64, height: 40, frames, errors: [], profile: { directProfile: "three-r185", exposures: [.5], hdrAttachmentProfile: "shared-rgba16f" } } };
  }));
}
test("actual full local matrix and positive canonical contribution passes", () => {
  const result = compareLocalDirect(fixture()); assert(result.passed && result.qualityCertified); assert.equal(result.rows.length, 6);
});
test("records strict direct failure without relaxing its tolerance", () => {
  const data = fixture(); for (const frame of data[0].run.frames.filter(frame => frame.stage === "direct-diagnostic")) frame.deep.hdr = frame.deep.hdr.map(value => value ? value + .01 : value);
  const result = compareLocalDirect(data); assert(result.passed); assert(!result.qualityCertified);
});
for (const [name, mutate] of [
  ["missing fixture", data => data.pop()],
  ["duplicate case", data => { data[2].kind = data[0].kind; }],
  ["primary enabled", data => { data[0].lighting.primary.intensity = 1; }],
  ["source drift", data => { data[1].receipt.originalHash = modified; }],
  ["zero module", data => { data[0].receipt.moduleCount = 0; }],
  ["empty Three compile", data => { data[0].receipt.threeCompiledHashes = []; }],
  ["wrong ablation source", data => { data[1].receipt.actualHash = h; }],
  ["wrong baseline", data => { data[0].run.profile.directProfile = "deep-single-scatter"; }],
  ["nonfinite HDR", data => { data[0].run.frames[0].deep.hdr[0] = Infinity; }],
  ["empty light", data => { data[0].lighting.clustered.points[0].intensity = 0; }],
  ["packet drift", data => { data[1].run.frames[2].packetHash = modified; }],
  ["no canonical contribution", data => { data[0].run.frames.forEach((frame, index) => { frame.deep = structuredClone(data[1].run.frames[index].deep); }); }],
]) test(`rejects ${name}`, () => { const data = fixture(); mutate(data); assert.throws(() => compareLocalDirect(data)); });
