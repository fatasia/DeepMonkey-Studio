import type { Deep2dCommand, Deep2dMatrix } from "../../deep2dDisplayList.js";
import type { DashboardCandidateNode } from "../../runtimePackage/dashboardCandidateTypes.js";
import type { Deep2dRuntimePackage } from "../../runtimePackage/types.js";
import { flattenPath, transform, type Point } from "./path.js";
import { fillPath, type Triangle } from "./fill.js";
import { strokePath } from "./stroke.js";
import { clipVertices } from "./clip.js";

export interface Deep2dFrameLayer { readonly node: DashboardCandidateNode; readonly content: Deep2dRuntimePackage;
  readonly atlasBytes: ReadonlyMap<string, Uint8Array<ArrayBuffer>> }
export interface Deep2dGpuDraw { readonly vertices: Float32Array<ArrayBuffer>; readonly atlasKey?: string }
export interface Deep2dGpuAtlas { readonly bytes: Uint8Array<ArrayBuffer>; readonly width: number; readonly height: number;
  readonly format: "r8unorm" | "rgba8unorm-srgb"; readonly sampling: "nearest" | "linear" }
export interface Deep2dGpuFrame { readonly draws: readonly Deep2dGpuDraw[]; readonly atlases: ReadonlyMap<string, Deep2dGpuAtlas>;
  readonly width: number; readonly height: number; readonly gpuBytes: number }

export function buildDeep2dGpuFrame(layers: readonly Deep2dFrameLayer[], pageWidth: number, pageHeight: number,
  width: number, height: number): Deep2dGpuFrame {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 8192)) throw new Error("Invalid WebGPU frame extent.");
  const scale = Math.min(width / pageWidth, height / pageHeight), ox = (width - pageWidth * scale) / 2, oy = (height - pageHeight * scale) / 2;
  const draws: Deep2dGpuDraw[] = [], atlases = new Map<string, Deep2dGpuAtlas>();
  let gpuBytes = width * height * 20, vertices = 0, commands = 0, atlasBytes = 0;
  const budget = () => { if (gpuBytes > 256 * 1024 * 1024 || vertices > 2_000_000 || commands > 262_144 || atlasBytes > 64 * 1024 * 1024)
    throw new Error("Combined Deep2D frame budget exceeded."); };
  budget();
  for (const [layerIndex, layer] of layers.entries()) {
    if (!layer.node.node.visible) continue;
    const content = layer.content, node = layer.node.node, prefix = `${layerIndex}:`;
    const paths = new Map(content.displayList.resources.filter(r => r.kind === "path").map(r => [r.id, r]));
    const translate = (matrix: Deep2dMatrix): Deep2dMatrix => [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4] + node.frame[0], matrix[5] + node.frame[1]];
    for (const atlas of content.atlases) {
      const bytes = layer.atlasBytes.get(atlas.id);
      if (!bytes || bytes.byteLength !== atlas.width * atlas.height * (atlas.kind === "glyph" ? 1 : 4)) throw new Error("Missing prepared Deep2D atlas bytes.");
      atlases.set(prefix + atlas.id, { bytes, width: atlas.width, height: atlas.height, format: atlas.format, sampling: atlas.sampling });
      atlasBytes += bytes.byteLength; gpuBytes += bytes.byteLength; budget();
    }
    const [cx, cy, cw, ch] = layer.node.effectiveClip;
    if (cw <= 0 || ch <= 0) continue;
    const pageClip: Triangle[] = [[[cx, cy], [cx + cw, cy], [cx + cw, cy + ch]], [[cx, cy], [cx + cw, cy + ch], [cx, cy + ch]]];
    const emit = (input: number[][], clips: readonly (readonly Triangle[])[], atlasKey?: string) => {
      const clipped = clipVertices(input, [pageClip, ...clips]); vertices += clipped.length; gpuBytes += clipped.length * 48; budget();
      if (!clipped.length) return;
      const data = new Float32Array(clipped.length * 12);
      // Clipping can reuse one source vertex in several output triangles. Keep
      // those shared arrays immutable or a later occurrence gets projected twice.
      clipped.forEach((v, i) => {
        const projected = [...v];
        projected[0] = (v[0]! * scale + ox) * 2 / width - 1;
        projected[1] = 1 - (v[1]! * scale + oy) * 2 / height;
        if (projected.some(n => !Number.isFinite(Math.fround(n)))) throw new Error("Non-finite Deep2D GPU vertex.");
        data.set(projected, i * 12);
      });
      draws.push({ vertices: data, ...(atlasKey ? { atlasKey } : {}) });
    };
    const path = (command: Deep2dCommand) => {
      if (command.kind !== "path") throw new Error("Deep2D text/images require baked atlas quads.");
      const source = paths.get(command.pathId); if (!source) throw new Error("Missing Deep2D path.");
      const matrix = translate(command.transform), linear = flattenPath(source.verbs, matrix, scale);
      const clips = (command.clipPathIds ?? []).map(id => {
        const source = paths.get(id); if (!source) throw new Error("Missing Deep2D clip.");
        const p = flattenPath(source.verbs, matrix, scale);
        if (p.length !== 1 || !p[0]!.closed) throw new Error("Unsupported Deep2D clip requires one closed subpath.");
        return fillPath(p).map(t => t.map(v => transform(v, matrix)) as unknown as Triangle);
      });
      const paint = (triangles: readonly Triangle[], color: readonly number[]) => emit(triangles.flatMap(t => t.map(p => [
        ...transform(p, matrix), color[0]!, color[1]!, color[2]!, color[3]! * (command.opacity ?? 1), 0, 0, 0, 0, 1, 1,
      ])), clips);
      if (command.fill) paint(fillPath(linear, command.fillRule), command.fill);
      if (command.stroke) paint(strokePath(linear, command, 0.25 / Math.max(1e-12, Math.hypot(...matrix.slice(0, 4)) * scale)), command.stroke);
    };
    const quad = (q: Deep2dRuntimePackage["quads"][number]) => {
      const atlas = atlases.get(prefix + q.atlasId); if (!atlas) throw new Error("Missing Deep2D atlas.");
      const [x, y, w, h] = q.destination, [sx, sy, sw, sh] = q.source, matrix = translate(q.transform);
      const p: Point[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      const uv = [[sx / atlas.width, sy / atlas.height], [(sx + sw) / atlas.width, sy / atlas.height],
        [(sx + sw) / atlas.width, (sy + sh) / atlas.height], [sx / atlas.width, (sy + sh) / atlas.height]];
      emit([0, 1, 2, 0, 2, 3].map(i => [...transform(p[i]!, matrix), q.color[0], q.color[1], q.color[2],
        q.color[3] * (q.opacity ?? 1), ...uv[i]!, (sx + 0.5) / atlas.width, (sy + 0.5) / atlas.height,
        (sx + sw - 0.5) / atlas.width, (sy + sh - 0.5) / atlas.height]), [], prefix + q.atlasId);
    };
    // Match Native's runtime_layers ordering exactly. sourceIndex is local to
    // its authored command/quad array; kindOrder resolves cross-kind z ties.
    const byZAndSource = (a: { zOrder: number; sourceIndex: number }, b: { zOrder: number; sourceIndex: number }) =>
      a.zOrder - b.zOrder || a.sourceIndex - b.sourceIndex;
    const pathEntries = content.displayList.commands.map((value, sourceIndex) =>
      ({ zOrder: value.zOrder, kindOrder: 0, sourceIndex, run: () => path(value) })).sort(byZAndSource);
    const quadEntries = content.quads.map((value, sourceIndex) =>
      ({ zOrder: value.zOrder, kindOrder: 1, sourceIndex, run: () => quad(value) })).sort(byZAndSource);
    const entries = [...pathEntries, ...quadEntries];
    commands += entries.length; budget();
    if (content.composition === "z-ordered") entries.sort((a, b) => a.zOrder - b.zOrder
      || a.kindOrder - b.kindOrder || a.sourceIndex - b.sourceIndex);
    else entries.sort((a, b) => a.kindOrder - b.kindOrder
      || a.zOrder - b.zOrder || a.sourceIndex - b.sourceIndex);
    for (const entry of entries) entry.run();
  }
  return { draws, atlases, width, height, gpuBytes };
}
