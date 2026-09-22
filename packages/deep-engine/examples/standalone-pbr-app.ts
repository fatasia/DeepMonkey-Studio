import type { RenderPacket } from "@bim-studio/deep-engine";
import { DeepApp, PbrRendererPlugin } from "@bim-studio/deep-engine/app";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";

interface StandaloneState {
  view: RenderView;
}

const triangle: RenderPacket = {
  geometries: [{ id: "triangle", revision: 1,
    vertices: new Float32Array([-1, -1, 0, 0, 0, 1, 1, -1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]) }],
  materials: [{ id: "steel", baseColor: [0.16, 0.38, 0.72], metallic: 0.8, roughness: 0.24 }],
  instances: [{ id: "main", geometry: "triangle", material: "steel",
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
};

/** A browser owns RAF and the canvas; no Studio editor runtime is involved. */
export async function startStandalonePbrApp(canvas: HTMLCanvasElement): Promise<() => Promise<void>> {
  const state: StandaloneState = { view: { eye: [0, 0, 5], target: [0, 0, 0], extent: 4,
    background: [0.015, 0.025, 0.045], floor: [0.08, 0.09, 0.11], exposure: 1,
    roughness: 0.5, width: canvas.clientWidth, height: canvas.clientHeight,
    pixelRatio: window.devicePixelRatio } };
  const app = await DeepApp.create({ state, mode: "always", plugins: [new PbrRendererPlugin<StandaloneState>({
    canvas, gpu: navigator.gpu, packet: triangle, view: frame => frame.state.view,
    renderer: { features: { toneMapping: "three-aces-r185", bloom: true } },
  })] });
  let stopped = false;
  const frame = async (timeMs: number): Promise<void> => {
    if (stopped) return;
    await app.advance(timeMs);
    if (!stopped && app.shouldRequestFrame()) requestAnimationFrame(value => void frame(value));
  };
  requestAnimationFrame(value => void frame(value));
  return async () => { stopped = true; await app.dispose(); };
}
