import assert from "node:assert/strict";
import test from "node:test";
import { createDeepBevyFixture, fixtureDescriptor } from "./deepBevyBenchmarkFixture.mjs";

test("creates the frozen hard-normal cube grid", () => {
  const packet = createDeepBevyFixture(256), descriptor = fixtureDescriptor(packet);
  assert.equal(packet.geometries[0].vertices.length, 24 * 6);
  assert.equal(packet.geometries[0].indices.length, 36);
  assert.equal(packet.instances.length, 256);
  assert.equal(descriptor.triangles, 3072);
  assert.match(descriptor.packetSha256, /^[a-f0-9]{64}$/);
});

test("rejects unsafe fixture sizes", () => {
  assert.throws(() => createDeepBevyFixture(0), /instanceCount/);
  assert.throws(() => createDeepBevyFixture(65_537), /instanceCount/);
});
