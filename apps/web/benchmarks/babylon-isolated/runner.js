import { Engine } from "./node_modules/@babylonjs/core/Engines/engine.js";
import { WebGPUEngine } from "./node_modules/@babylonjs/core/Engines/webgpuEngine.js";
import { Scene } from "./node_modules/@babylonjs/core/scene.js";
import { ArcRotateCamera } from "./node_modules/@babylonjs/core/Cameras/arcRotateCamera.js";
import { HemisphericLight } from "./node_modules/@babylonjs/core/Lights/hemisphericLight.js";
import { Vector3 } from "./node_modules/@babylonjs/core/Maths/math.vector.js";
import { MeshBuilder } from "./node_modules/@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "./node_modules/@babylonjs/core/Materials/standardMaterial.js";

const qs = new URLSearchParams(location.search), count = Math.max(1, +(qs.get("objects") || 1000));
const warmup = Math.max(1, +(qs.get("warmup") || 30)), samples = Math.max(1, +(qs.get("samples") || 120));
const canvas = document.querySelector("#c");
const init = async () => {
  const engine = await (WebGPUEngine.IsSupportedAsync ? WebGPUEngine.IsSupportedAsync() : false)
    ? WebGPUEngine.CreateAsync(canvas, { antialias: true }) : Promise.resolve(new Engine(canvas, true));
  const scene = new Scene(engine), camera = new ArcRotateCamera("camera", 0.8, 1.1, Math.sqrt(count) * 1.8, Vector3.Zero(), scene);
  camera.attachControl(canvas, true); new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  const mat = new StandardMaterial("mat", scene); mat.diffuseColor.set(0.24, 0.52, 0.82);
  const side = Math.ceil(Math.sqrt(count)); for (let i = 0; i < count; i++) { const m = MeshBuilder.CreateBox(`b${i}`, { size: 0.8 }, scene); m.position.set((i % side) - side / 2, 0, Math.floor(i / side) - side / 2); m.material = mat; }
  const times = []; let frame = 0, start = performance.now();
  await new Promise(resolve => { engine.runRenderLoop(() => { const t = performance.now(); scene.render(); if (++frame > warmup) times.push(performance.now() - t); if (times.length >= samples) { engine.stopRenderLoop(); resolve(); } }); });
  const sorted = [...times].sort((a,b)=>a-b), pct = p => sorted[Math.min(sorted.length-1, Math.floor(sorted.length*p))];
  const report = { schema: "babylon-isolated-v1", engine: "babylon", backend: engine.webGPUVersion ? "webgpu" : "webgl", objects: count, canvas: [canvas.width,canvas.height], dpr: devicePixelRatio, warmup, samples, frameMs: { mean: times.reduce((a,b)=>a+b,0)/times.length, p50:pct(.5), p95:pct(.95), p99:pct(.99) }, elapsedMs: performance.now()-start, asset: "fixed-box-fixture", generatedAt: new Date().toISOString() };
  console.log("BABYLON_BENCHMARK_JSON " + JSON.stringify(report)); window.__BABYLON_BENCHMARK__ = report;
}; init().catch(e => { console.error(e); window.__BABYLON_BENCHMARK_ERROR__ = String(e); });
