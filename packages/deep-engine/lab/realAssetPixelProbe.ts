/// <reference types="@webgpu/types" />
import type { PbrRenderer, RenderPacket, RenderView } from "@bim-studio/deep-engine/webgpu";
import { loadModelPacket } from "./modelPacket.js";
import { readPresentationPixels, type SurfacePixels } from "./assetPixelReadback.js";
import {
  backgroundResponse, evaluateAlphaModes, evaluateTextureEncoding, foregroundSample,
  type AlphaModeEvidence, type TextureEncodingEvidence,
} from "./realAssetPixelAnalysis.js";

const TEXTURE_ROWS = Object.freeze([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]] as const);
const ALPHA_NODES = Object.freeze({ opaque: 8, blend: 4, low: 5, defaultCutoff: 7, high: 6 } as const);
const DARK: readonly [number, number, number] = [0.001, 0.001, 0.001];
const LIGHT: readonly [number, number, number] = [0.42, 0.42, 0.42];

export interface RealAssetPixelProbeResult {
  readonly action: "real-gltf-pixel-semantics";
  readonly success: boolean;
  readonly textureEncoding?: TextureEncodingEvidence;
  readonly alphaModes?: AlphaModeEvidence;
  readonly checks?: Readonly<{ textureEncoding: boolean; alphaModes: boolean;
    gpuErrorsClean: boolean; deviceDiagnosticsClean: boolean; nonFallbackAdapter: boolean }>;
  readonly gpuErrors: readonly string[];
  readonly failure?: string;
}

/** Runs opt-in, real-asset rendering checks against the production PBR renderer and its presentation surface. */
export async function verifyRealAssetPixelSemantics(
  renderer: PbrRenderer,
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
): Promise<RealAssetPixelProbeResult> {
  if (renderer.session.state !== "ready") throw new Error("Real-asset pixel probe requires a ready renderer.");
  const diagnosticsBefore = renderer.session.diagnostics.length, gpuErrors: string[] = [];
  let textureEncoding: TextureEncodingEvidence | undefined, alphaModes: AlphaModeEvidence | undefined;
  let failure: string | undefined;
  for (const filter of ["validation", "out-of-memory", "internal"] as const) renderer.session.device.pushErrorScope(filter);
  try {
    signal?.throwIfAborted();
    const [texturePacket, alphaPacket] = await Promise.all([
      loadModelPacket("TextureEncodingTest", 1, signal),
      loadModelPacket("AlphaBlendModeTest", 1, signal),
    ]);
    const darkBaseline = await capture(renderer, canvas, emptyPacket(), DARK, "baseline-dark", signal);
    const rows = [];
    for (const [rowIndex, nodes] of TEXTURE_ROWS.entries()) {
      const samples = [];
      for (const node of nodes) {
        const subject = await capture(renderer, canvas,
          isolate(texturePacket, node, `encoding-${rowIndex}-${node}`), DARK, `encoding-${rowIndex}-${node}`, signal);
        samples.push(foregroundSample(subject, darkBaseline));
      }
      rows.push(Object.freeze(samples));
    }
    textureEncoding = Object.freeze({ rows: Object.freeze(rows) });

    const lightBaseline = await capture(renderer, canvas, emptyPacket(), LIGHT, "baseline-light", signal);
    const opaqueDark = await capture(renderer, canvas, isolate(alphaPacket, ALPHA_NODES.opaque, "opaque-dark"), DARK, "opaque-dark", signal);
    const opaqueLight = await capture(renderer, canvas, isolate(alphaPacket, ALPHA_NODES.opaque, "opaque-light"), LIGHT, "opaque-light", signal);
    const blendDark = await capture(renderer, canvas, isolate(alphaPacket, ALPHA_NODES.blend, "blend-dark"), DARK, "blend-dark", signal);
    const blendLight = await capture(renderer, canvas, isolate(alphaPacket, ALPHA_NODES.blend, "blend-light"), LIGHT, "blend-light", signal);
    const maskCoverage = [];
    for (const [name, node] of [["low", ALPHA_NODES.low], ["default", ALPHA_NODES.defaultCutoff], ["high", ALPHA_NODES.high]] as const) {
      const subject = await capture(renderer, canvas, isolate(alphaPacket, node, `mask-${name}`), DARK, `mask-${name}`, signal);
      maskCoverage.push(foregroundSample(subject, darkBaseline).coverage);
    }
    alphaModes = Object.freeze({
      opaqueBackgroundResponse: backgroundResponse(opaqueDark, opaqueLight, darkBaseline, lightBaseline),
      blendBackgroundResponse: backgroundResponse(blendDark, blendLight, darkBaseline, lightBaseline),
      maskCoverage: Object.freeze(maskCoverage) as unknown as readonly [number, number, number],
    });
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    for (let index = 0; index < 3; index++) {
      try { const error = await renderer.session.device.popErrorScope(); if (error) gpuErrors.push(error.message); }
      catch (error) { gpuErrors.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  const checks = textureEncoding && alphaModes ? Object.freeze({
    textureEncoding: evaluateTextureEncoding(textureEncoding),
    alphaModes: evaluateAlphaModes(alphaModes),
    gpuErrorsClean: gpuErrors.length === 0,
    deviceDiagnosticsClean: renderer.session.diagnostics.length === diagnosticsBefore,
    nonFallbackAdapter: renderer.session.adapterInfo?.isFallbackAdapter === false,
  }) : undefined;
  return Object.freeze({ action: "real-gltf-pixel-semantics",
    success: failure === undefined && !!checks && Object.values(checks).every(Boolean),
    ...(textureEncoding ? { textureEncoding } : {}), ...(alphaModes ? { alphaModes } : {}),
    ...(checks ? { checks } : {}), gpuErrors: Object.freeze(gpuErrors), ...(failure ? { failure } : {}) });
}

async function capture(renderer: PbrRenderer, canvas: HTMLCanvasElement, packet: RenderPacket,
  color: readonly [number, number, number], suffix: string, signal?: AbortSignal): Promise<SurfacePixels> {
  signal?.throwIfAborted();
  const unique = { ...packet, instances: packet.instances.map(instance => ({ ...instance, id: `${instance.id}/${suffix}` })) };
  await renderer.setPacketValidated(unique, signal);
  const view = probeView(canvas, color);
  await renderer.validateFrame(view); await renderer.validateFrame(view);
  signal?.throwIfAborted();
  return readPresentationPixels(renderer.session, canvas);
}

function isolate(packet: RenderPacket, node: number, suffix: string): RenderPacket {
  const instance = packet.instances.find(value => value.id.includes(`/node/${node}/primitive/`));
  if (!instance) throw new Error(`Real-asset pixel probe node is missing: ${node}.`);
  const geometry = packet.geometries.find(value => value.id === instance.geometry);
  if (!geometry) throw new Error(`Real-asset pixel probe geometry is missing: ${instance.geometry}.`);
  return { geometries: packet.geometries, materials: packet.materials,
    ...(packet.textures ? { textures: packet.textures } : {}),
    instances: [{ ...instance, id: `${instance.id}/${suffix}`, transform: centeredTransform(instance.transform, geometry.vertices) }] };
}

function centeredTransform(source: ArrayLike<number>, vertices: Float32Array): readonly number[] {
  const matrix = Array.from(source), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < vertices.length; offset += 6) for (let axis = 0; axis < 3; axis++) {
    const value = matrix[axis]! * vertices[offset]! + matrix[4 + axis]! * vertices[offset + 1]!
      + matrix[8 + axis]! * vertices[offset + 2]! + matrix[12 + axis]!;
    min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value);
  }
  const size = Math.max(...max.map((value, axis) => value - min[axis]!));
  if (!Number.isFinite(size) || size <= 0) throw new Error("Real-asset pixel probe geometry has an empty world bound.");
  const factor = 1.15 / size, center = max.map((value, axis) => (value + min[axis]!) / 2);
  for (let column = 0; column < 3; column++) for (let axis = 0; axis < 3; axis++) matrix[column * 4 + axis]! *= factor;
  matrix[12] = factor * (matrix[12]! - center[0]!) + 0;
  matrix[13] = factor * (matrix[13]! - center[1]!) + 0.7;
  matrix[14] = factor * (matrix[14]! - center[2]!) + 0;
  return Object.freeze(matrix);
}

function probeView(canvas: HTMLCanvasElement, color: readonly [number, number, number]): RenderView {
  return { width: canvas.clientWidth, height: canvas.clientHeight, pixelRatio: 1,
    eye: [0, 0.7, 3], target: [0, 0.7, 0], up: [0, 1, 0], extent: 1.35, near: 0.1, far: 20,
    background: color, floor: color, exposure: 1, roughness: 1 };
}
const emptyPacket = (): RenderPacket => ({ geometries: [], materials: [], instances: [] });
