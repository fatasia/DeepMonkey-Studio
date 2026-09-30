import test from "node:test";
import assert from "node:assert/strict";
import { compareDeviceRecovery } from "./j3DeviceRecoveryParity.mjs";
const manifest = { packageHash: "same-package", packetHash: "same-packet", phases: ["initial-device", "uploaded", "first-valid-frame",
  "lost-observed", "old-host-retired", "recreated", "uploaded", "first-valid-frame", "disposed"] };
const run = () => ({ phases: manifest.phases, lossReason: "destroyed", newDevice: true,
  firstFrameValid: true, firstFrameStable: true, liveComponentsAtLoss: true, maxError: 0, coloredPixels: 100,
  resourcesAfter: 0, ownedEstimatedBytesAfter: 0 });
const leg = () => ({ ...manifest, passed: true, runs: [run(), run()] });

test("matching actual-device phase evidence passes while excluding unmeasured scope", () => {
  const evidence = compareDeviceRecovery(manifest, leg(), leg());
  assert.equal(evidence.passed, true); assert.equal(evidence.phaseSamplesPerHost, 18);
  assert.ok(evidence.excluded.includes("physical driver VRAM"));
});
test("missing Native leg cannot become a dual-host proof", () => {
  assert.throws(() => compareDeviceRecovery(manifest, leg(), undefined), /missing two/);
});
test("a different CPU package/packet is rejected", () => {
  const native = leg(); native.packetHash = "different-scene";
  assert.throws(() => compareDeviceRecovery(manifest, leg(), native), /manifest identity/);
});
test("unobserved loss, empty first-frame or no replacement device is rejected", () => {
  for (const mutation of [{ lossReason: "unknown" }, { newDevice: false }, { coloredPixels: 0 }, { firstFrameStable: false }, { liveComponentsAtLoss: false }]) {
    const native = leg(); Object.assign(native.runs[0], mutation);
    assert.throws(() => compareDeviceRecovery(manifest, leg(), native), /proof missing/);
  }
});
test("wrong phases or Web ownership residual cannot pass", () => {
  const native = leg(); native.runs[0].phases = ["disposed"];
  assert.throws(() => compareDeviceRecovery(manifest, leg(), native), /phase contract/);
  const web = leg(); web.runs[0].resourcesAfter = 1;
  assert.throws(() => compareDeviceRecovery(manifest, web, leg()), /return to zero/);
});
