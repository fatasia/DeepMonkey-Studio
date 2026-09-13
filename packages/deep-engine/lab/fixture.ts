import type { RenderView, Vec3 } from "@bim-studio/deep-engine/webgpu";

export function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing fixture element: ${id}`);
  return value as T;
}

function linear(channel: number): number { return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; }
export function tokenColor(name: string): Vec3 {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number);
  probe.remove();
  if (!rgb || rgb.length < 3) throw new Error(`Invalid color token ${name}`);
  return [linear(rgb[0]! / 255), linear(rgb[1]! / 255), linear(rgb[2]! / 255)];
}

export interface FixtureState { count: number; angle: number; exposure: number; roughness: number; motion: boolean }
export type SceneViewProfile = "benchmark" | "single-model-detail";
export function sceneExtent(count: number, profile: SceneViewProfile = "benchmark"): number {
  if (profile === "single-model-detail" && count === 1) return 1.25;
  return Math.max(4, Math.ceil(Math.sqrt(count)) * 1.7);
}
export function instances(count: number): Float32Array<ArrayBuffer> {
  const side = Math.ceil(Math.sqrt(count)), accent = tokenColor("--accent"), ceramic = tokenColor("--text-strong"), steel = tokenColor("--text-muted");
  const data = new Float32Array(count * 12);
  for (let i = 0; i < count; i++) {
    const x = i % side, z = Math.floor(i / side);
    const metal = x / Math.max(1, side - 1), roughness = 0.12 + 0.83 * z / Math.max(1, side - 1);
    const color = x < side / 3 ? ceramic : x < side * 2 / 3 ? accent : steel;
    data.set([(x - (side - 1) / 2) * 2.4, 0.85, (z - (side - 1) / 2) * 2.4, 0.85, ...color, metal, roughness, 0, 0, 0], i * 12);
  }
  return data;
}

export function view(canvas: HTMLCanvasElement, state: FixtureState, background: Vec3, floor: Vec3,
  profile: SceneViewProfile = "benchmark"): RenderView {
  const extent = sceneExtent(state.count, profile);
  const aspect = Math.max(0.1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
  const radius = extent * Math.max(2.7, 2.7 / aspect);
  return { width: canvas.clientWidth, height: canvas.clientHeight, pixelRatio: devicePixelRatio,
    eye: [Math.sin(state.angle) * radius * 0.76, radius * 0.66, Math.cos(state.angle) * radius * 0.76],
    target: [0, profile === "single-model-detail" ? 0.58 : -extent * 0.08, 0], extent,
    background, floor, exposure: state.exposure, roughness: state.roughness };
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}
