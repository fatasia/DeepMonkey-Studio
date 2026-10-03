import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { PbrRenderer, type RenderView } from "../src/webgpu/pbrRenderer.js";
import type { RenderPacket } from "../src/renderPacket.js";

/** 实例描边 GPU 探针:同一布局分别走 Deep(PbrRenderer + outline 实例)与 three OutlinePass(作者 WebGL)。 */
const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "deep";
const outlineOn = params.get("outline") !== "0";
const width = Number(params.get("w") ?? 1920), height = Number(params.get("h") ?? 1080);
const strength = Number(params.get("strength") ?? 2.5);
const eye: [number, number, number] = [6, 4.2, 8.5], target: [number, number, number] = [0, 1, 0];
const fov = 0.8;

interface Shape { id: string; geometry: THREE.BufferGeometry; position: [number, number, number]; color: string; outline: boolean }
const shapes: Shape[] = [
  { id: "sphere-a", geometry: new THREE.SphereGeometry(1, 48, 24), position: [-2.6, 1, 0.2], color: "#c98a3a", outline: true },
  { id: "wall-b", geometry: new THREE.BoxGeometry(1.4, 2.2, 0.5), position: [1.0, 1.1, 1.0], color: "#6d7f92", outline: false },
  { id: "cylinder-c", geometry: new THREE.CylinderGeometry(0.7, 0.7, 2, 40), position: [2.0, 1, -0.6], color: "#4f9b7a", outline: true },
  { id: "sphere-d", geometry: new THREE.SphereGeometry(0.5, 32, 16), position: [-0.4, 0.5, 3], color: "#b24f4f", outline: false },
  { id: "box-e", geometry: new THREE.BoxGeometry(1.2, 1.2, 1.2), position: [-1.2, 0.6, -2.4], color: "#8d6fb3", outline: true },
];

function interleave(geometry: THREE.BufferGeometry): { vertices: Float32Array; indices: Uint32Array } {
  const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal");
  const vertices = new Float32Array(position.count * 6);
  for (let i = 0; i < position.count; i++) {
    vertices.set([position.getX(i), position.getY(i), position.getZ(i), normal.getX(i), normal.getY(i), normal.getZ(i)], i * 6);
  }
  const index = geometry.getIndex()!;
  return { vertices, indices: Uint32Array.from(index.array as ArrayLike<number>) };
}
const hex = (value: string): [number, number, number] => { const c = new THREE.Color(value); return [c.r, c.g, c.b]; };

async function runDeep(canvas: HTMLCanvasElement) {
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 1024 } },
  });
  const packet: RenderPacket = {
    geometries: shapes.map(shape => ({ id: shape.id, revision: 1, ...interleave(shape.geometry) })),
    materials: shapes.map(shape => ({ id: shape.id, baseColor: hex(shape.color), metallic: 0, roughness: 0.55 })),
    // Column-major 4x4 (same as ThreeProjectionBridge): translation in elements 12..14.
    instances: shapes.map(shape => ({ id: shape.id, geometry: shape.id, material: shape.id,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...shape.position, 1] as const,
      ...(outlineOn && shape.outline ? { outline: true } : {}) })),
  };
  const view: RenderView = {
    width, height, pixelRatio: 1, eye, target, up: [0, 1, 0], extent: 12,
    verticalFovRadians: fov, near: 0.1, far: 100, background: [0.07, 0.09, 0.11], floor: [0.16, 0.18, 0.2], exposure: 1, roughness: 1,
    lights: { directional: [{ directionWorld: [-0.4, -0.8, -0.45], color: [1, 0.97, 0.92], intensity: 2.4, castShadow: true,
      shadow: { viewProjection: [0.05, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, -0.02, 0, 0, 0, 0.5, 1], mapSize: 1024, bias: 0.0005, normalBias: 0.02, intensity: 1, radius: 1 } }] },
    ...(outlineOn && strength !== 2.5 ? { postProcess: { instanceOutline: { strength } } } : {}),
  };
  await renderer.setPacketValidated(packet);
  let metrics;
  for (let frame = 0; frame < 10; frame++) {
    metrics = renderer.render(view);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  await renderer.session.device.queue.onSubmittedWorkDone();
  return { backend: "deep", metrics: { drawCalls: metrics?.drawCalls, postProcessPasses: metrics?.postProcessPasses, outline: metrics?.outline },
    diagnostics: renderer.session.diagnostics };
}

async function runThree(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1); renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0.07, 0.09, 0.11);
  const camera = new THREE.PerspectiveCamera(fov * 180 / Math.PI, width / height, 0.1, 100);
  camera.position.set(...eye); camera.lookAt(...target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.16, 0.18, 0.2), roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const selected: THREE.Object3D[] = [];
  for (const shape of shapes) {
    const mesh = new THREE.Mesh(shape.geometry, new THREE.MeshStandardMaterial({ color: shape.color, roughness: 0.55 }));
    mesh.position.set(...shape.position); mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh);
    if (shape.outline && outlineOn) selected.push(mesh);
  }
  scene.add(new THREE.HemisphereLight(0xaabbcc, 0x223344, 0.8));
  const sun = new THREE.DirectionalLight(0xfff7ea, 2.4); sun.position.set(4, 8, 4.5); sun.castShadow = true; scene.add(sun);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const outline = new OutlinePass(new THREE.Vector2(width, height), scene, camera);
  outline.visibleEdgeColor.set(0x4d9fff); outline.hiddenEdgeColor.set(0x234a71);
  outline.edgeStrength = strength; outline.selectedObjects = selected; outline.enabled = selected.length > 0;
  composer.addPass(outline);
  composer.addPass(new OutputPass());
  composer.setSize(width, height);
  for (let frame = 0; frame < 3; frame++) { composer.render(); await new Promise(resolve => requestAnimationFrame(resolve)); }
  return { backend: "three-webgl" };
}

const canvas = document.createElement("canvas");
canvas.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px`;
document.body.style.margin = "0"; document.body.append(canvas);
const status = document.createElement("pre"); status.id = "status"; status.style.cssText = "position:fixed;left:0;bottom:0;color:#0f0;margin:0;font:12px monospace;display:none";
document.body.append(status);
(mode === "three" ? runThree(canvas) : runDeep(canvas)).then(result => {
  (window as unknown as { __probe: unknown }).__probe = { ok: true, ...result }; document.title = "DONE";
}).catch(error => { (window as unknown as { __probe: unknown }).__probe = { ok: false, error: String(error?.stack ?? error) }; document.title = "FAIL"; });
