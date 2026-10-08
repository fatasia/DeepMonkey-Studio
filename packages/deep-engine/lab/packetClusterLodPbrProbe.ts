/// <reference types="@webgpu/types" />
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { RenderView } from "../src/webgpu/pbrRenderer.js";
import type { RenderPacket } from "../src/renderPacket.js";

function packet(): RenderPacket {
  const vertices: number[] = [], indices: number[] = [];
  for (let z = 0; z <= 20; z++) for (let x = 0; x <= 20; x++) vertices.push(x, 0, z, 0, 1, 0);
  for (let z = 0; z < 20; z++) for (let x = 0; x < 20; x++) {
    const a = z * 21 + x; indices.push(a, a + 21, a + 1, a + 1, a + 21, a + 22);
  }
  return { geometries: ["grid-red", "grid-blue"].map(id => ({ id, revision: 1, vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) })),
    materials: [{ id: "red", baseColor: [0.9, 0.02, 0.01], roughness: 0.3, metallic: 0.2 },
      { id: "blue", baseColor: [0.01, 0.04, 0.9], roughness: 0.8, metallic: 0.6 }],
    instances: ["red", "blue"].map((material, index) => ({ id: material, geometry: `grid-${material}`, material,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 25, 0, 0, 1] })) };
}

async function pixels(renderer: PbrRenderer, canvas: HTMLCanvasElement, view: RenderView): Promise<Uint8Array> {
  const { session } = renderer, width = canvas.width, height = canvas.height;
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = session.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    // Swapchain textures expire on the next browser task; encode the draw and copy synchronously.
    renderer.render(view);
    const encoder = session.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: session.context.getCurrentTexture() }, { buffer, bytesPerRow }, [width, height]);
    session.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange()), result = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) result.set(source.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    return result;
  } finally { if (buffer.mapState === "mapped") buffer.unmap(); buffer.destroy(); }
}

async function run(clusterLod: boolean, mrt: boolean) {
  const canvas = document.createElement("canvas"); canvas.style.width = "256px"; canvas.style.height = "256px";
  document.querySelector("#canvases")!.append(canvas);
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    clusterLod, msaaSampleCount: 1,
    features: { environment: false, fog: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
      screenSpaceReflection: false, volumetricFog: false, temporalAa: mrt, spatialAa: false, bloom: false,
      vignette: false, contactShadows: false, occlusionCulling: false },
  });
  const view: RenderView = { width: 256, height: 256, pixelRatio: 1, extent: 45,
    eye: [22, 40, 60], target: [22, 0, 10], background: [0.005, 0.01, 0.015], floor: [0, 0, 0],
    exposure: 1, roughness: 1, fog: null, verticalFovRadians: Math.PI / 4, near: 0.1, far: 10000,
    lights: { directional: [{ directionWorld: [0, -1, 0], color: [1, 1, 1], intensity: 4, castShadow: false }] } };
  try {
    await renderer.setPacketValidated(packet());
    const frames = [];
    for (let frame = 0; frame < 8; frame++) {
      frames.push(await renderer.validateFrame(view));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const near = await pixels(renderer, canvas, view);
    const preview = document.createElement("canvas"); preview.width = 256; preview.height = 256;
    const display = new Uint8ClampedArray(near);
    if (renderer.session.format.startsWith("bgra")) for (let i = 0; i < display.length; i += 4) {
      const red = display[i]!; display[i] = display[i + 2]!; display[i + 2] = red;
    }
    preview.getContext("2d")!.putImageData(new ImageData(display, 256, 256), 0, 0);
    canvas.replaceWith(preview);
    const farView: RenderView = { ...view, eye: [22, 1000, 1500] };
    let far;
    for (let frame = 0; frame < 5; frame++) {
      far = await renderer.validateFrame(farView); await new Promise(resolve => setTimeout(resolve, 0));
    }
    const returningNearFirst = await renderer.validateFrame(view);
    await new Promise(resolve => setTimeout(resolve, 0));
    let returningNearSettled = returningNearFirst;
    for (let frame = 0; frame < 4; frame++) {
      returningNearSettled = await renderer.validateFrame(view); await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { near, first: frames[0], settled: frames.at(-1), far, returningNearFirst, returningNearSettled,
      diagnostics: renderer.session.diagnostics.map(value => value.message) };
  } finally { renderer.dispose(); }
}

export async function runPacketClusterPbrProbe() {
  const results = [];
  for (const mrt of [false, true]) {
    const baseline = await run(false, mrt), clustered = await run(true, mrt);
    let changedPixels = 0, maximumChannelDelta = 0, coloredPixels = 0;
    for (let i = 0; i < baseline.near.length; i += 4) {
      let changed = false;
      for (let c = 0; c < 3; c++) { const delta = Math.abs(baseline.near[i + c]! - clustered.near[i + c]!);
        maximumChannelDelta = Math.max(maximumChannelDelta, delta); changed ||= delta > 0; }
      if (changed) changedPixels++;
      if (Math.max(...baseline.near.subarray(i, i + 3)) - Math.min(...baseline.near.subarray(i, i + 3)) > 20) coloredPixels++;
    }
    const metrics = clustered.settled?.clusterLodProduction;
    const passed = changedPixels === 0 && coloredPixels > 100 && metrics?.sections === 2 && (metrics?.draws ?? 0) > 0 && !metrics?.warming
      && metrics?.fallbackReasons.length === 0 && clustered.far!.triangles < baseline.far!.triangles
      && clustered.returningNearFirst.clusterLodProduction?.draws === 0
      && clustered.returningNearFirst.triangles === baseline.returningNearFirst.triangles
      && (clustered.returningNearSettled.clusterLodProduction?.draws ?? 0) > 0
      && !clustered.diagnostics.length;
    results.push({ mrt, passed, changedPixels, maximumChannelDelta, coloredPixels, first: clustered.first,
      settled: clustered.settled, far: clustered.far, baselineFarTriangles: baseline.far!.triangles,
      returningNearFirst: clustered.returningNearFirst, returningNearSettled: clustered.returningNearSettled,
      diagnostics: clustered.diagnostics });
  }
  return { success: results.every(result => result.passed), results };
}

const button = document.querySelector<HTMLButtonElement>("#run");
button?.addEventListener("click", async () => {
  button.disabled = true; const output = document.querySelector("#result")!;
  try { const result = await runPacketClusterPbrProbe(); output.textContent = JSON.stringify(result, null, 2);
    await fetch("/result", { method: "POST", body: JSON.stringify(result) }); }
  catch (error) { output.textContent = String(error); await fetch("/result", { method: "POST", body: JSON.stringify({ success: false, error: String(error) }) }); }
});
