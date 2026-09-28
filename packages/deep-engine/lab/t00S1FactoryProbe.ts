import { createAssetBenchmarkScene, type BenchmarkInstanceCount } from "./benchmarkScene.js";
import { benchmarkFixtureIdentity } from "./benchmarkFixtureIdentity.js";
import { DeepBenchmarkBackend } from "./deepBenchmarkBackend.js";
import { assertBenchmarkImage } from "./benchmarkImage.js";

let active: DeepBenchmarkBackend | undefined;

async function run(count: BenchmarkInstanceCount) {
  active?.dispose(); active = undefined;
  const fixture = await createAssetBenchmarkScene("FactoryMachine", count);
  if (fixture.packet.instances.length !== count || fixture.packet.geometries.length !== 1)
    throw new Error("S1 Factory fixture instance or geometry count changed.");
  const identity = await benchmarkFixtureIdentity(fixture);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(identity)));
  const fixtureSha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  const canvas = document.querySelector<HTMLCanvasElement>("#candidate-canvas");
  if (!canvas) throw new Error("Missing existing benchmark canvas.");
  const backend = await DeepBenchmarkBackend.create(canvas, fixture, new AbortController().signal, "baseline-equivalent");
  try {
    const frame = backend.render(); await backend.settle();
    const image = await backend.capture(); assertBenchmarkImage(image, "S1 Factory Deep WebGPU");
    active = backend;
    return { schema: 1, id: fixture.id, fixtureSha256, source: fixture.assetIdentity,
      instances: fixture.packet.instances.length, geometries: fixture.packet.geometries.length,
      materials: fixture.packet.materials.length, textures: fixture.packet.textures?.length ?? 0,
      trianglesPerInstance: fixture.packet.geometries[0]!.indices.length / 3,
      view: { width: fixture.view.width, height: fixture.view.height, eye: fixture.view.eye,
        target: fixture.view.target, fovRadians: fixture.view.verticalFovRadians },
      frame: { drawCalls: frame.drawCalls, triangles: frame.triangles },
      image: { sha256: image.sha256, meanLuminance: image.meanLuminance,
        geometryDetailFraction: image.geometryDetailFraction }, errors: backend.errors() };
  } catch (error) { backend.dispose(); throw error; }
}

(globalThis as typeof globalThis & { __t00S1FactoryProbe?: typeof run }).__t00S1FactoryProbe = run;
