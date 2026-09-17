import { test } from "node:test";
import assert from "node:assert/strict";
import { scanResourceAllocations } from "./auditResourceAdmission.mjs";

test("distinguishes admitted gateways, late ownership, and separate resource owners", () => {
  const code = `session.own(device.createBuffer({ size: 4 }));
own(device.createTexture({}));
const query = device.createQuerySet({ count: 2 });
// device.createBuffer({}) is a comment, not an allocation.
const name = "device.createTexture";`;
  const calls = scanResourceAllocations("webgpu/example.ts", code);
  assert.deepEqual(calls.map(({ operation, boundary, line }) => ({ operation, boundary, line })), [
    { operation: "createBuffer", boundary: "ownership-after-allocation", line: 1 },
    { operation: "createTexture", boundary: "separate-owner-review", line: 2 },
    { operation: "createQuerySet", boundary: "separate-owner-review", line: 3 },
  ]);
  assert.equal(scanResourceAllocations("webgpu/resourceAdmission.ts", code)[0].boundary, "admitted-gateway");
});

test("does not claim helper calls or dynamic aliases are verified allocations", () => {
  assert.deepEqual(scanResourceAllocations("webgpu/example.ts", "createAdmittedBuffer(session, {}); allocate({});"), []);
});
