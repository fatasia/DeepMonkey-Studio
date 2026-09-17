/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { prepareRenderPacket } from "../src/renderPacket.js";
import { buildDeepRuntimePackage, parseDeepRuntimePackage, serializeDeepRuntimePackage } from "../src/runtimePackage/index.js";
import { materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import { ThreeProjectionBridge } from "../src/threeBridge/ThreeProjectionBridge.js";
import { PbrRenderer, type RenderView } from "../src/webgpu/index.js";

const SIZE = 192;
type CaseName = "front" | "front-mirror" | "double" | "double-mirror" | "premultiplied-mirror";

function author(name: CaseName): THREE.Mesh {
  const alpha = 0.45;
  const material = new THREE.MeshStandardMaterial({
    color: "#f06b36", metalness: 0, roughness: 0.82, transparent: true,
    opacity: alpha, depthWrite: false,
    side: name.startsWith("double") || name.startsWith("premultiplied") ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (name.startsWith("premultiplied")) {
    material.premultipliedAlpha = true;
    material.color.multiplyScalar(alpha);
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.25, 0.22), material);
  mesh.name = name;
  mesh.rotation.set(0.24, 0.55, -0.12);
  if (name.includes("mirror")) mesh.scale.x = -1;
  return mesh;
}

function bridge(): ThreeProjectionBridge {
  return new ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender,
    objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow,
    objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender,
    materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  } });
}

function publish(name: CaseName) {
  const root = author(name); root.updateWorldMatrix(true, true);
  const projection = bridge().project(root, { cameraLayerMask: 1 });
  if (!projection.ok) throw new Error(JSON.stringify(projection.issues));
  const built = buildDeepRuntimePackage({ packageId: `c03.${name}`, packageVersion: "1.0.0",
    renderPacket: { id: "scene.main", revision: 1, value: projection.packet } });
  const packageJson = serializeDeepRuntimePackage(built), parsed = parseDeepRuntimePackage(packageJson);
  if (!parsed.valid) throw new Error(parsed.issues[0]?.message ?? "Published package did not parse.");
  const payload = parsed.value.payloads[parsed.value.entrypoints.renderPacket];
  const packet = materializeRuntimeRenderPacket(payload, "$.payloads.scene.main");
  const prepared = prepareRenderPacket(packet), batch = prepared.batches[0];
  if (!batch || prepared.batches.length !== 1) throw new Error(`${name} did not publish one batch.`);
  return { packet, packageHash: parsed.value.packageHash.value, flags: batch.data[31]!,
    mirrored: batch.mirrored, doubleSided: batch.doubleSided,
    premultipliedAlpha: batch.premultipliedAlpha === true };
}

const view: RenderView = {
  width: SIZE, height: SIZE, pixelRatio: 1, eye: [3.2, 2.1, 4.4], target: [0, 0, 0], extent: 2.1,
  background: [0.018, 0.028, 0.034], floor: [0.03, 0.045, 0.052], exposure: 1, roughness: 1,
  fog: null,
};

async function render(name: CaseName) {
  const figure = document.createElement("figure"), canvas = document.createElement("canvas");
  canvas.width = SIZE; canvas.height = SIZE; canvas.style.width = `${SIZE}px`; canvas.style.height = `${SIZE}px`;
  const caption = document.createElement("figcaption"); caption.textContent = name;
  figure.append(canvas, caption); document.querySelector("main")!.append(figure);
  const published = publish(name), abort = new AbortController();
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, abort.signal, { features: {
    environment: true, fog: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
    temporalAa: false, spatialAa: false, occlusionCulling: false, bloom: false, vignette: false,
  } });
  try {
    const context = renderer.session.context as GPUCanvasContext & { getCurrentTexture: () => GPUTexture };
    const acquire = context.getCurrentTexture.bind(context); let presented: GPUTexture | undefined;
    context.getCurrentTexture = () => { presented = acquire(); return presented; };
    await renderer.setPacketValidated(published.packet, abort.signal);
    renderer.session.device.pushErrorScope("validation");
    const frame = renderer.render(view);
    if (!frame) throw new Error(`${name} did not render a production frame.`);
    if (!presented) throw new Error(`${name} did not acquire a presentation texture.`);
    const pixels = await readPixels(renderer.session.device, presented, renderer.session.format);
    const gpuError = await renderer.session.device.popErrorScope();
    if (gpuError) throw new Error(gpuError.message);
    const preview = document.createElement("canvas"); preview.width = SIZE; preview.height = SIZE;
    preview.style.width = `${SIZE}px`; preview.style.height = `${SIZE}px`;
    preview.getContext("2d")!.putImageData(new ImageData(Uint8ClampedArray.from(pixels.rgba), SIZE, SIZE), 0, 0);
    canvas.replaceWith(preview);
    const changedPixels = countChanged(pixels.rgba);
    return { packageHash: published.packageHash, flags: published.flags, mirrored: published.mirrored,
      doubleSided: published.doubleSided, premultipliedAlpha: published.premultipliedAlpha,
      frame: { drawCalls: frame.drawCalls, triangles: frame.triangles,
      weightedOit: frame.weightedOit }, checksum: pixels.checksum, changedPixels,
      rgba: Array.from(pixels.rgba), diagnostics: [...renderer.session.diagnostics] };
  } finally { renderer.dispose(); }
}

async function readPixels(device: GPUDevice, texture: GPUTexture, format: GPUTextureFormat) {
  const bytesPerRow = SIZE * 4, buffer = device.createBuffer({ size: bytesPerRow * SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: SIZE }, [SIZE, SIZE]);
    device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange()), rgba = new Uint8Array(source.length);
    const bgra = format.startsWith("bgra"); let hash = 0x811c9dc5;
    for (let offset = 0; offset < source.length; offset += 4) {
      rgba[offset] = source[offset + (bgra ? 2 : 0)]!; rgba[offset + 1] = source[offset + 1]!;
      rgba[offset + 2] = source[offset + (bgra ? 0 : 2)]!; rgba[offset + 3] = source[offset + 3]!;
      for (let channel = 0; channel < 4; channel++) hash = Math.imul(hash ^ rgba[offset + channel]!, 0x01000193);
    }
    buffer.unmap(); return { rgba, checksum: (hash >>> 0).toString(16).padStart(8, "0") };
  } finally { if (buffer.mapState === "mapped") buffer.unmap(); buffer.destroy(); }
}

function countChanged(rgba: Uint8Array): number {
  const corner = rgba.slice(0, 4); let changed = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset] !== corner[0] || rgba[offset + 1] !== corner[1] || rgba[offset + 2] !== corner[2]) changed++;
  }
  return changed;
}

function maxDiff(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Infinity;
  let result = 0; for (let index = 0; index < a.length; index++) result = Math.max(result, Math.abs(a[index]! - b[index]!));
  return result;
}

declare global { interface Window { __c03Publication?: unknown } }

void (async () => {
  const names: CaseName[] = ["front", "front-mirror", "double", "double-mirror", "premultiplied-mirror"];
  const entries = await Promise.all(names.map(async name => [name, await render(name)] as const));
  const cases = Object.fromEntries(entries) as Record<CaseName, Awaited<ReturnType<typeof render>>>;
  const comparisons = {
    frontMirror: maxDiff(cases.front.rgba, cases["front-mirror"].rgba),
    doubleMirror: maxDiff(cases.double.rgba, cases["double-mirror"].rgba),
  };
  const premultiplied = cases["premultiplied-mirror"];
  const success = comparisons.frontMirror <= 1 && comparisons.doubleMirror <= 1
    && (premultiplied.flags & 128) === 128 && (premultiplied.flags & 1) === 1
    && premultiplied.premultipliedAlpha && premultiplied.doubleSided
    && Object.values(cases).every(result => result.frame.weightedOit && result.changedPixels >= 500)
    && Object.values(cases).every(result => result.diagnostics.length === 0);
  for (const result of Object.values(cases)) delete (result as { rgba?: number[] }).rgba;
  window.__c03Publication = { success, comparisons, cases };
  document.querySelector("pre")!.textContent = JSON.stringify(window.__c03Publication, null, 2);
})().catch(error => {
  window.__c03Publication = { success: false, error: error instanceof Error ? error.stack : String(error) };
  document.querySelector("pre")!.textContent = JSON.stringify(window.__c03Publication, null, 2);
});
