import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url), { build } = require("../packages/deep-engine/node_modules/esbuild");
const compiled = await build({ entryPoints: [path.join(root, "packages/deep-engine/src/webgpu/cameraMath.ts")],
  bundle: true, format: "esm", platform: "node", write: false });
// Import the official implementation; do not maintain another camera formula here.
const { multiply, perspective, lookAt } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
const sourceFixture = "packages/deep-engine-native/tests/fixtures/runtime-package-v1.json";
const source = JSON.parse(await readFile(path.join(root, sourceFixture), "utf8"));
const width = 128, height = 128;
const cameras = [{ id: "axis", eye: [0, 0, 8] }, { id: "oblique", eye: [3, 2, 8] }].map(camera => {
  const view = { ...camera, target: [0, 0, 0], up: [0, 1, 0], verticalFovRadians: 1, near: .1, far: 100 };
  return { ...view, expectedVP: Array.from(multiply(perspective(view.verticalFovRadians, width / height,
    view.near, view.far), lookAt(view.eye, view.target, view.up))) };
});
const packetHash = createHash("sha256").update(JSON.stringify(source.payloads[source.entrypoints.renderPacket])).digest("hex");
const manifest = { schema: "j3-geometry-depth-v1", sourceFixture, packageHash: source.packageHash.value, packetHash,
  width, height, cameras, thresholds: { vpMaxError: 2e-5, depthMaxError: 2e-6, planeMaxError: 2e-6, minStablePixels: 64, edgeRadius: 1 } };
await writeFile(path.join(root, "packages/deep-engine/fixtures/j3-geometry-depth-v1.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated actual cameraMath reference for ${cameras.length} fixed cameras; ${packetHash}`);
