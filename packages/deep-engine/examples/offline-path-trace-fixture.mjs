import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { serializeBrowserRenderPacket } from "../dist/runtimePackage/renderPacket.js";
import { decodeRadianceHdr } from "@bim-studio/deep-engine";
import { sampleDirectDfg185 } from "../dist/webgpu/directDfgLut185.js";

/** Locally authored IOR1 dielectric and full-metal stock PBR, sharing one quad BLAS. */
export async function writePathTraceFixture(directory) {
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  const packet = { geometries: [{ id: "quad", revision: 1,
    vertices: new Float32Array([-0.5, -0.5, 0, 0, 0, 1, 0.5, -0.5, 0, 0, 0, 1,
      0.5, 0.5, 0, 0, 0, 1, -0.5, 0.5, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }],
    materials: [
      { id: "lambert", baseColor: [0.7, 0.5, 0.2], metallic: 0, roughness: 1, ior: 1, doubleSided: true },
      { id: "ggx", baseColor: [1, 1, 1], metallic: 1, roughness: 1, doubleSided: true },
    ], instances: [
      { id: "diffuse-panel", geometry: "quad", material: "lambert", transform: [1, 0, 0, 0, 0, 1.3, 0, 0, 0, 0, 1, 0, -0.7, 0, 0, 1] },
      { id: "metal-panel", geometry: "quad", material: "ggx", transform: [1, 0, 0, 0, 0, 1.3, 0, 0, 0, 0, 1, 0, 0.7, 0, 0, 1] },
    ] };
  const camera = { schema: "deep-engine.scene-camera", schemaVersion: 1, id: "camera", revision: 1,
    position: [0, 0, 3], target: [0, 0, 0], verticalFovDegrees: 30, near: 0.1, far: 100 };
  const packetPath = join(target, "scene.json"), cameraPath = join(target, "camera.json");
  await writeFile(packetPath, serializeBrowserRenderPacket(packet) + "\n");
  await writeFile(cameraPath, JSON.stringify(camera, null, 2) + "\n");
  return { packetPath, cameraPath };
}


/** Independent normal-cosine quadrature of C8's wide lobe. No trace kernel or PDF calls. */
function fullMetalMultipleIntegral(nv) {
  const [av,bv]=sampleDirectDfg185(1,nv),sv=av+bv,lv=1-sv;
  const count=4096;let sum=0;
  for(let i=0;i<count;i++){
    const nl=(i+.5)/count,[al,bl]=sampleDirectDfg185(1,nl),sl=al+bl,ll=1-sl;
    const multiple=sv*sl/(1-lv*ll+0.000001)*(lv*ll);
    sum+=multiple*nl*2*Math.PI/count;
  }return sum;
}
/** Independent single-scatter closed reference plus C8 numerical integral. */
export async function verifyPathTraceFixtureHdr(path) {
  const bytes = await readFile(path), image = decodeRadianceHdr(bytes);
  const receipt = JSON.parse(await readFile(path + ".receipt.json", "utf8"));
  assert.equal(receipt.status, "final"); assert.equal(receipt.converged, true);
  assert.equal(receipt.instanceCount, 2); assert.equal(receipt.uniqueBlasCount, 1);
  assert.equal(receipt.hdrSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(receipt.roundtripMaxAbsoluteError <= receipt.maximumLinearValue / 128);
  const halfHeight = 3 * Math.tan(30 * Math.PI / 360), halfWidth = halfHeight * image.width / image.height;
  const margin = 3 * Math.max(2 * halfWidth / image.width, 2 * halfHeight / image.height);
  let lambertSquaredError = 0, ggxSquaredError = 0, lambertPixels = 0, ggxPixels = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const worldX = ((x + 0.5) / image.width * 2 - 1) * halfWidth;
    const worldY = (1 - (y + 0.5) / image.height * 2) * halfHeight;
    if (Math.abs(worldY) > 0.65 - margin) continue;
    const offset = (y * image.width + x) * 3;
    if (worldX > -1.2 + margin && worldX < -0.2 - margin) {
      lambertPixels++;
      for (const [channel, expected] of [0.7, 0.5, 0.2].entries()) {
        lambertSquaredError += (image.data[offset + channel] - expected) ** 2 / 3;
      }
    } else if (worldX > 0.2 + margin && worldX < 1.2 - margin) {
      ggxPixels++;
      // GGX alpha=1, F=1, correlated Smith: integral = 1 - nv*ln((1+nv)/nv).
      // The pixel-center view is an independent approximation to its tiny jitter footprint.
      const nv = 1 / Math.hypot(worldX / 3, worldY / 3, 1);
      const expected = 1 - nv * Math.log((1 + nv) / nv) + fullMetalMultipleIntegral(nv);
      ggxSquaredError += (image.data[offset] - expected) ** 2;
      assert.equal(image.data[offset], image.data[offset + 1]); assert.equal(image.data[offset], image.data[offset + 2]);
    }
  }
  assert.ok(lambertPixels > 0 && ggxPixels > 0, "Resolution must cover interior pixels of both fixture panels.");
  const lambertRmse = Math.sqrt(lambertSquaredError / lambertPixels), ggxRmse = Math.sqrt(ggxSquaredError / ggxPixels);
  assert.ok(lambertRmse < 0.004, `Lambert RMSE ${lambertRmse}`);
  assert.ok(ggxRmse < 0.03, `GGX RMSE ${ggxRmse}`);
  return { ...receipt, independentReference: { lambertPixels, lambertRmse, ggxPixels, ggxRmse,
    lambertGate: 0.004, ggxGate: 0.03, ggxFormula: "1-nv*ln((1+nv)/nv)+independent C8 cosine integral" } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, path] = process.argv.slice(2);
  if (!path || (operation !== "create" && operation !== "verify")) {
    process.stderr.write("Usage: node examples/offline-path-trace-fixture.mjs create DIRECTORY | verify FINAL.hdr\n"); process.exitCode = 1;
  } else {
    const result = operation === "create" ? await writePathTraceFixture(path) : await verifyPathTraceFixtureHdr(path);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}
