import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as THREE from "three";
import { buildNativeFixture } from "./deep-native-fixture.mts";
import { parseNativeReport, median } from "./deep-native-bench-metrics.mjs";
import { fixtureCameraDistance, fixtureObjects } from "../benchmarks/render-engine/src/fixture.ts";

const geometry = {
  box: new THREE.BoxGeometry(2, 2, 2), sphere: new THREE.SphereGeometry(1, 32, 20),
  cylinder: new THREE.CylinderGeometry(1, 1, 2, 32), cone: new THREE.ConeGeometry(1, 2, 32),
  torus: new THREE.TorusGeometry(1, 0.32, 18, 48), capsule: new THREE.CapsuleGeometry(0.65, 1.4, 8, 16),
};
for (const count of [120, 1000]) test(`native ${count}: matches browser geometry, transforms, PBR and camera`, async () => {
  const { runtimePackage: pkg, manifest } = await buildNativeFixture(count);
  const packet = pkg.payloads[pkg.entrypoints.renderPacket] as any;
  assert.equal(packet.instances.length, count + 1);
  assert.equal(packet.geometries.length, 7);
  assert.equal(packet.materials.length, 7);
  let triangles = 2;
  for (const object of fixtureObjects(count)) {
    const instance = packet.instances.find((item: any) => item.id === `fixture-${object.index}`);
    const compiled = packet.geometries.find((item: any) => item.id === instance.geometry);
    const reference = geometry[object.kind];
    assert.deepEqual(compiled.indices, [...reference.index!.array]);
    const vertices: number[] = [];
    const positions = reference.getAttribute("position"), normals = reference.getAttribute("normal");
    for (let i = 0; i < positions.count; i++) vertices.push(positions.getX(i), positions.getY(i), positions.getZ(i),
      normals.getX(i), normals.getY(i), normals.getZ(i));
    assert.deepEqual(compiled.vertices, vertices.map(value => value === 0 ? 0 : value));
    const referenceObject = new THREE.Object3D();
    referenceObject.position.set(object.position[0], object.kind === "torus" ? 0.35 : object.kind === "capsule" ? 1.35 : 1, object.position[2]);
    referenceObject.rotation.y = object.rotationY;
    referenceObject.scale.set(...object.scale);
    referenceObject.updateMatrix();
    assert.deepEqual(instance.transform, referenceObject.matrix.elements.map(value => Math.fround(value) || 0));
    const material = packet.materials.find((item: any) => item.id === instance.material);
    assert.equal(material.roughness, 0.72);
    assert.equal(material.metallic, 0.05);
    new THREE.Color(object.color).toArray().forEach((channel, index) => {
      assert(Math.abs(material.baseColor[index] - channel) < 1e-9);
    });
    assert.equal(instance.castShadow, true);
    assert.equal(instance.receiveShadow, true);
    triangles += reference.index!.count / 3;
  }
  assert.equal(manifest.triangles, triangles);
  const ground = packet.instances.find((item: any) => item.id === "fixture-ground");
  assert.equal(ground.castShadow, false);
  assert.equal(ground.receiveShadow, true);
  assert.equal(ground.transform[0], fixtureCameraDistance(count));
  assert("camera" in pkg.entrypoints);
  const camera = pkg.payloads[pkg.entrypoints.camera] as any;
  assert.equal(camera.verticalFovDegrees, 48);
  assert.equal(camera.near, 0.1);
  assert.equal(camera.far, 5000);
  assert.equal(manifest.sourceBytes, 0);
  const env = pkg.payloads[pkg.entrypoints.environment] as any;
  assert.equal(env.lighting.exposure, 1.05);
  assert.equal(env.lighting.shadows, true);
  assert.equal(env.lighting.localLights[0].kind, "hemisphere");
});

test("fixture package is deterministic and rejects unsupported counts", async () => {
  assert.equal((await buildNativeFixture(120)).runtimePackage.packageHash.value,
    (await buildNativeFixture(120)).runtimePackage.packageHash.value);
  await assert.rejects(buildNativeFixture(0), /120 or 1000/);
});

function report() {
  return { schema: "deep-engine.native-player-report", build: { profile: "release" },
    content: { runtime_package_id: "bench.native-120", runtime_package_sha256: "test-hash" },
    sampling: { sample_frames: 8, warmup_frames: 2 }, metrics: {
      frames: { presented: 8, attempted: 8, skipped: 0, failed: 0, recoveries: 0 }, packet_updates: 0,
      benchmark_sample_window: { schema: "deep-engine.benchmark-sample-window", windowStartMs: 0, windowEndMs: 40,
        channels: [{ channel: "frame-interval", clockId: "host-monotonic", availability: "measured",
          sampleCount: 7, samplesMs: [7, 1, 2, 3, 4, 5, 6] }] } } };
}
const options = { count: 120, frames: 8, warmup: 2, packageHash: "test-hash" };
const stdout = (value: unknown) => `native telemetry report: ${JSON.stringify(value)}\nnative frame presented: 1440x900\n`;
test("native quantiles use browser nearest rank, retain all samples and window", () => {
  const parsed = parseNativeReport(stdout(report()), options);
  assert.deepEqual(parsed.frames, { samples: 7, p50Ms: 4, p95Ms: 7, p99Ms: 7, maximumMs: 7, windowMs: 40 });
  assert.equal(median([3, 1, 2]), 2);
});
test("rejects missing, truncated, failed, wrong-package and invalid interval evidence", () => {
  for (const mutate of [
    (value: any) => { value.content.runtime_package_sha256 = "other"; },
    (value: any) => { value.build.profile = "debug"; },
    (value: any) => { value.metrics.frames.failed = 1; },
    (value: any) => { value.metrics.frames.presented = 7; },
    (value: any) => { value.metrics.packet_updates = 1; },
    (value: any) => { value.metrics.benchmark_sample_window.channels[0].samplesMs.pop(); },
    (value: any) => { value.metrics.benchmark_sample_window.channels[0].samplesMs[0] = 0; },
    (value: any) => { value.metrics.benchmark_sample_window.channels[0].samplesMs[0] = 1000; },
  ]) {
    const value = report(); mutate(value);
    assert.throws(() => parseNativeReport(stdout(value), options));
  }
  assert.throws(() => parseNativeReport("", options));
  assert.throws(() => parseNativeReport(stdout(report()) + stdout(report()), options));
  assert.throws(() => parseNativeReport(stdout(report()).replace("1440x900", "960x640"), options));
});

function observedReport(workload: string) {
  const value: any = report();
  value.metrics.packet_updates = workload === "static" ? 0 : 8;
  value.metrics.gpu = { status: "supported", dropped: 0, late: 0 };
  value.metrics.benchmark_sample_window.channels.push({ channel: "gpu-timestamp", availability: "measured",
    clockId: "gpu-timestamp", sampleCount: 8, samplesMs: [8, 1, 2, 3, 4, 5, 6, 7] });
  value.metrics.benchmark = { schema: "deep-engine.fixture-benchmark", version: 1, observerBuild: true,
    workload, movingObjects: workload === "dynamic" ? 200 : 0, measuredUpdates: workload === "static" ? 0 : 8,
    drawCommands: Array(8).fill(9), rebuildMs: workload === "rebuild" ? [8, 7, 6, 5, 4, 3, 2, 1] : [],
    heapBytes: workload === "rebuild" ? [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800] : [] };
  return value;
}
const observedStdout = (value: any) => stdout(value)
  + `native benchmark first present: ${JSON.stringify({ workload: value.metrics.benchmark.workload })}\n`;
test("full GPU window and real workload statistics are required", () => {
  for (const workload of ["static", "dynamic", "rebuild"]) {
    const value = observedReport(workload);
    const parsed = parseNativeReport(observedStdout(value), { ...options, workload });
    assert.equal(parsed.benchmark!.gpuP50Ms, 4);
    assert.equal(parsed.benchmark!.drawCalls, 9);
    if (workload === "rebuild") {
      assert.equal(parsed.benchmark!.lastRebuildMs, 1);
      assert.equal(parsed.benchmark!.heapDeltaBytes, 800);
    }
  }
  for (const mutate of [
    (v: any) => { v.metrics.benchmark.observerBuild = false; },
    (v: any) => { v.metrics.benchmark.measuredUpdates = 7; },
    (v: any) => { v.metrics.benchmark.drawCommands[0] = 0; },
    (v: any) => { v.metrics.benchmark.rebuildMs.pop(); },
    (v: any) => { v.metrics.benchmark.heapBytes[0] = NaN; },
    (v: any) => { v.metrics.gpu.dropped = 1; },
    (v: any) => { v.metrics.benchmark_sample_window.channels[1].samplesMs.pop(); },
    (v: any) => { v.metrics.benchmark_sample_window.channels[1].availability = "unavailable"; },
  ]) {
    const value = observedReport("rebuild"); mutate(value);
    assert.throws(() => parseNativeReport(observedStdout(value), { ...options, workload: "rebuild" }));
  }
  assert.throws(() => parseNativeReport(stdout(observedReport("rebuild")), { ...options, workload: "rebuild" }));
});
