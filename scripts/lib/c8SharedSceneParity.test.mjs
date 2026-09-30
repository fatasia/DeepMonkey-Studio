import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSharedScene } from "./c8SharedSceneParity.mjs";

function fixture() {
  const width = 64, height = 48, identity = "a".repeat(64), frames = [];
  for (const stage of ["strict-emissive", "direct-diagnostic"]) for (let camera = 0; camera < 2; camera++) for (const exposure of [.5, 2]) {
    const hdr = Array(width * height * 3).fill(0), display = Array(width * height * 4).fill(0);
    for (let y = 4; y < height - 4; y++) for (let x = 4; x < width - 4; x++) {
      const pixel = y * width + x; hdr.fill(stage === "strict-emissive" ? .2 : .4, pixel * 3, pixel * 3 + 3); display.fill(100, pixel * 4, pixel * 4 + 4);
    }
    const leg = { hdr, display, rootHash: identity, profileHash: identity, drawCalls: 6, triangles: 2000 };
    frames.push({ name: `${stage}/${camera}/${exposure}`, stage, camera, exposure, rootHash: identity, profileHash: identity, packetHash: identity, three: structuredClone(leg), deep: structuredClone(leg) });
  }
  return { width, height, frames, errors: [] };
}
test("identical actual-shape data and direct contribution satisfy registered split", () => assert(compareSharedScene(fixture()).passed));
for (const [name, mutate] of [
  ["extent", run => { run.frames[0].deep.hdr.pop(); }],
  ["identity", run => { run.frames[0].deep.rootHash = "b".repeat(64); }],
  ["nonfinite", run => { run.frames[0].deep.hdr[1000] = NaN; }],
  ["all black", run => { run.frames[0].deep.hdr.fill(0); }],
  ["missing geometry", run => { for (let y = 12; y < 30; y++) for (let x = 12; x < 30; x++) run.frames[0].deep.hdr.fill(0, (y * run.width + x) * 3, (y * run.width + x) * 3 + 3); }],
  ["HDR tolerance", run => { run.frames[0].deep.hdr[20 * run.width * 3 + 20 * 3] += .003; }],
  ["surface tolerance", run => { run.frames[0].deep.display[20 * run.width * 4 + 20 * 4] += 3; }],
  ["direct light empty", run => { run.frames[4].deep.hdr = [...run.frames[0].deep.hdr]; }],
  ["empty matrix", run => { run.frames = []; }],
  ["reused camera matrix", run => { run.frames[2].camera = 0; }],
  ["missing production batches", run => { run.frames[0].deep.drawCalls = 1; }],
]) test(`rejects ${name}`, () => { const run = fixture(); mutate(run); assert.throws(() => compareSharedScene(run)); });

test("explicit one-exposure diagnostics retain the complete actual matrix", () => {
  const run = fixture(); run.frames = run.frames.filter(frame => frame.exposure === .5);
  assert(compareSharedScene(run, { exposures: [.5] }).passed);
  assert.throws(() => compareSharedScene(run));
  delete run.frames[0].exposure; assert.throws(() => compareSharedScene(run, { exposures: [.5] }));
});
test("rejects unknown, undefined, duplicate and empty exposure options", () => {
  for (const exposures of [undefined, [], [.5, .5], [1], [NaN]]) assert.throws(() => compareSharedScene(fixture(), { exposures }));
});
