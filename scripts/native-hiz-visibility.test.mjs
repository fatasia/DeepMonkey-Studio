import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { hiZOcclusionVisible, projectHiZOcclusionAabb } from "../packages/deep-engine/dist/webgpu/hiZOcclusionProjection.js";

const base = new URL("../packages/deep-engine-native/", import.meta.url);
const shader = await readFile(new URL("assets/shaders/native_gpu_occlusion_v1.wgsl", base), "utf8");
const extract = await readFile(new URL("assets/shaders/native_hi_z_extract_v1.wgsl", base), "utf8");
const pyramid = await readFile(new URL("src/renderer/hi_z_pyramid.rs", base), "utf8");

test("a partial occluder cannot remove an otherwise visible object or MSAA edge", () => {
  const mixed = [.2, .2, .2, 1], nearest = .7;
  assert.equal(hiZOcclusionVisible(nearest, mixed, false, 1e-6), true);
  assert.equal(Math.min(...mixed) + 1e-6 < nearest, true, "old min test falsely rejects this object");
  assert.equal(Math.max(...mixed) + 1e-6 < nearest, false);
  assert.equal(hiZOcclusionVisible(nearest, [.2, .2, .2, .2], false, 1e-6), false);
  assert.match(shader, /scene_max = max\(scene_max, textureLoad/);
  assert.match(extract, /farthest = max\(farthest, textureLoad/);
  assert.match(pyramid, /include_str!\(".*dcir_hi_z_first_stage_max_v1\.wgsl"\)/);
  assert.match(pyramid, /include_str!\(".*dcir_hi_z_variable_reduce_max_v1\.wgsl"\)/);
});

test("positive clip Y samples the upper texture half and keeps a full bounded footprint", () => {
  const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const projected = projectHiZOcclusionAabb([0,.5,.6], .1, identity, [0,0,-2], [1280,720], 11, false);
  assert.equal(projected.testable, true);
  assert.deepEqual(projected.uvRect, [.45,.2,.55,.3]);
  assert.match(shader, /vec2f\(ndc_low\.x, -ndc_high\.y\)/);
  assert.match(shader, /vec2f\(ndc_high\.x, -ndc_low\.y\)/);
  assert.match(shader, /any\(high - low \+ vec2i\(1\) > vec2i\(side_cap\)\)/);
  assert.ok(!shader.includes("low_capped"), "bounded work must preserve, rather than crop, an oversized footprint");
});

test("off-axis sphere projection includes nearer points missed by center-depth radii", () => {
  const center = [2,1,3], radius = 1, focal = [1.2,1.6];
  const clip = [center[0]*focal[0], center[1]*focal[1]], near = center[2]-radius, far = center[2]+radius;
  const low = clip.map((v,i) => Math.min((v-focal[i]*radius)/near,(v-focal[i]*radius)/far));
  const high = clip.map((v,i) => Math.max((v+focal[i]*radius)/near,(v+focal[i]*radius)/far));
  let oldMisses = 0;
  for (let ring=0;ring<=32;ring++) for(let segment=0;segment<64;segment++) {
    const theta=ring*Math.PI/32, phi=segment*Math.PI/32;
    const point=[center[0]+Math.sin(theta)*Math.cos(phi),center[1]+Math.cos(theta),center[2]+Math.sin(theta)*Math.sin(phi)];
    for(let axis=0;axis<2;axis++) {
      const ndc=point[axis]*focal[axis]/point[2];
      assert.ok(ndc>=low[axis]-1e-12 && ndc<=high[axis]+1e-12);
      if(ndc>(clip[axis]+focal[axis]*radius)/center[2]) oldMisses++;
    }
  }
  assert.ok(oldMisses>0, "center-depth projection underestimates a real sphere footprint");
  assert.match(shader, /ndc_low = min\(.*nearest_w.*farthest_w/);
  assert.match(shader, /sqrt\(norm_1 \* norm_infinity\)/);
});
