/// <reference types="@webgpu/types" />
import {
  prepareRenderPacket,
  type GeometryResource,
  type RenderPacket,
} from "@bim-studio/deep-engine";
import {
  createPacketResidencyLoader,
  sphereMesh,
  type FrameMetrics,
  type GpuRenderResidencyRequest,
  type GpuRenderResidencyRuntime,
  type PbrRenderer,
  type RenderView,
  type ResidentPacketProjection,
} from "@bim-studio/deep-engine/webgpu";
import { readPartialLodSurface, type PartialLodSurfaceEvidence } from "./pbrPartialLodReadback.js";

interface UploadEvidence {
  readonly coarseGpuResources: number;
  readonly fineGpuResources: number;
  readonly firstResidents: readonly string[];
  readonly replacementResidents: readonly string[];
}
interface ResourceEvidence {
  readonly baseline: number;
  readonly coarseFrame: number;
  readonly fineStage: number;
  readonly fineFrame: number;
  readonly farFrame: number;
  readonly afterCleanup: number;
  readonly retiredBeforeFineFrame: number;
  readonly retiredAfterFineFrame: number;
  readonly retiredAfterCleanup: number;
  readonly rendererCacheDelta: number;
}
interface DrawEvidence {
  readonly coarse: Pick<FrameMetrics, "drawCalls" | "triangles" | "lodSelectionBatches" | "lodIndirectDraws">;
  readonly fine: Pick<FrameMetrics, "drawCalls" | "triangles" | "lodSelectionBatches" | "lodIndirectDraws">;
  readonly far: Pick<FrameMetrics, "drawCalls" | "triangles" | "lodSelectionBatches" | "lodIndirectDraws">;
}
export interface PbrPartialLodResidencyProbeResult {
  readonly action: "pbr-partial-lod-residency";
  readonly success: boolean;
  readonly coarseOnlyActuallyDrew: boolean;
  readonly coarseStagePreservedLegacyFrame: boolean;
  readonly fineStagePreservedCoarseFrameAndLease: boolean;
  readonly finePublishedAtFrameBoundary: boolean;
  readonly farViewSelectedCoarse: boolean;
  readonly uploadsExactlyOnce: boolean;
  readonly leaseRetirementOrdered: boolean;
  readonly streamedResourcesReleased: boolean;
  readonly rendererCacheBounded: boolean;
  readonly gpuErrorScopesClean: boolean;
  readonly deviceDiagnosticsClean: boolean;
  readonly nonFallbackAdapter: boolean;
  readonly surfaces: Readonly<{ legacy: PartialLodSurfaceEvidence; coarseStage: PartialLodSurfaceEvidence;
    coarse: PartialLodSurfaceEvidence; fineStage: PartialLodSurfaceEvidence;
    fine: PartialLodSurfaceEvidence; far: PartialLodSurfaceEvidence }>;
  readonly uploads: UploadEvidence;
  readonly resources: ResourceEvidence;
  readonly draws: DrawEvidence;
  readonly gpuErrors: readonly string[];
  readonly failure?: string;
}

type ProbeChecks = Omit<PbrPartialLodResidencyProbeResult, "action" | "success" | "failure">;
export function evaluatePbrPartialLodResidencyProbe(result: ProbeChecks): boolean {
  return result.coarseOnlyActuallyDrew && result.coarseStagePreservedLegacyFrame
    && result.fineStagePreservedCoarseFrameAndLease && result.finePublishedAtFrameBoundary
    && result.farViewSelectedCoarse && result.uploadsExactlyOnce && result.leaseRetirementOrdered
    && result.streamedResourcesReleased && result.rendererCacheBounded
    && result.gpuErrorScopesClean && result.deviceDiagnosticsClean
    && result.nonFallbackAdapter;
}

/** Proves partial LOD upload, selection, replacement, and lease retirement on the production renderer. */
export async function verifyPbrPartialLodResidency(
  renderer: PbrRenderer,
  canvas: HTMLCanvasElement,
): Promise<PbrPartialLodResidencyProbeResult> {
  const session = renderer.session, diagnosticsBefore = session.diagnostics.length;
  if (session.state !== "ready") throw new Error("Partial LOD probe requires a ready renderer.");
  const legacy = legacyPacket(), prepared = prepareRenderPacket(lodPacket());
  const loader = createPacketResidencyLoader(prepared), gpuErrors: string[] = [];
  let runtime: GpuRenderResidencyRuntime | undefined, coarseProjection: ResidentPacketProjection | undefined;
  let fineProjection: ResidentPacketProjection | undefined, failure: string | undefined, restored = false;
  let coarseLeaseHeldDuringFineStage = false, leasesSwappedAtFineFrame = false;
  let baseline = -1, beforeCoarseUpload = -1, afterCoarseUpload = -1, coarseFrameResources = -1;
  let beforeFineUpload = -1, afterFineUpload = -1;
  let fineStageResources = -1, fineFrameResources = -1, farFrameResources = -1, retiredBefore = -1, retiredAfter = -1;
  let firstResidents: string[] = [], replacementResidents: string[] = [];
  let legacySurface = emptySurface(), coarseStageSurface = emptySurface(), coarseSurface = emptySurface();
  let fineStageSurface = emptySurface(), fineSurface = emptySurface(), farSurface = emptySurface();
  let coarseFrame: FrameMetrics | undefined, fineFrame: FrameMetrics | undefined, farFrame: FrameMetrics | undefined;
  for (const filter of ["validation", "out-of-memory", "internal"] as const) session.device.pushErrorScope(filter);
  try {
    await renderer.setPacketValidated(legacy);
    session.context.configure({ device: session.device, format: session.format, alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    await renderSurface(renderer, canvas, nearView(canvas));
    ({ surface: legacySurface } = await renderSurface(renderer, canvas, nearView(canvas)));
    baseline = session.resourceCount;

    runtime = loader.createRuntime(session,
      { maxResidentBytes: 1024 * 1024, maxUploadBytesPerFrame: 1024 * 1024 },
      { maxConcurrentUploads: 2 });
    const coarseRequest = request(loader.requests, "coarse");
    const fineRequest = request(loader.requests, "fine");
    beforeCoarseUpload = session.resourceCount;
    coarseProjection = await loader.loadInto(runtime,
      { frame: 20_001, requests: [coarseRequest], allowPartialLod: true });
    afterCoarseUpload = session.resourceCount;
    firstResidents = residentIds(runtime);
    requireFrame(renderer.render(nearView(canvas)));
    const legacyRead = readPartialLodSurface(session, canvas);
    const coarseStage = renderer.stageResidentPacketValidated(coarseProjection);
    const coarseStageRead = readPartialLodSurface(session, canvas);
    await Promise.all([legacyRead, coarseStageRead, coarseStage]);
    legacySurface = await legacyRead; coarseStageSurface = await coarseStageRead;
    ({ frame: coarseFrame, surface: coarseSurface } = await renderSurface(renderer, canvas, nearView(canvas)));
    coarseFrameResources = session.resourceCount;

    beforeFineUpload = session.resourceCount;
    fineProjection = await loader.loadInto(runtime,
      { frame: 20_002, requests: [coarseRequest, fineRequest], allowPartialLod: true });
    afterFineUpload = session.resourceCount;
    replacementResidents = residentIds(runtime);
    coarseFrame = requireFrame(renderer.render(nearView(canvas)));
    const coarseRead = readPartialLodSurface(session, canvas);
    const fineStage = renderer.stageResidentPacketValidated(fineProjection);
    const fineStageRead = readPartialLodSurface(session, canvas);
    await Promise.all([coarseRead, fineStageRead, fineStage]);
    coarseSurface = await coarseRead; fineStageSurface = await fineStageRead;
    coarseLeaseHeldDuringFineStage = !coarseProjection.released && !fineProjection.released;
    fineStageResources = session.resourceCount;
    runtime.dispose(); retiredBefore = runtime.retiredBytes;
    ({ frame: fineFrame, surface: fineSurface } = await renderSurface(renderer, canvas, nearView(canvas)));
    fineFrameResources = session.resourceCount; retiredAfter = runtime.retiredBytes;
    leasesSwappedAtFineFrame = coarseProjection.released && !fineProjection.released;
    ({ frame: farFrame, surface: farSurface } = await renderSurface(renderer, canvas, farView(canvas)));
    farFrameResources = session.resourceCount;

  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    try { await renderer.setPacketValidated(legacy);
      await renderSurface(renderer, canvas, nearView(canvas));
      await renderSurface(renderer, canvas, nearView(canvas)); restored = true; }
    catch (error) { failure ??= `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`; }
    coarseProjection?.release(); fineProjection?.release(); runtime?.dispose();
    for (let index = 0; index < 3; index++) {
      try { const error = await session.device.popErrorScope(); if (error) gpuErrors.push(error.message); }
      catch (error) { gpuErrors.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  const retiredAfterCleanup = runtime?.retiredBytes ?? -1;
  const coarseGpuResources = afterCoarseUpload - beforeCoarseUpload;
  const fineGpuResources = afterFineUpload - beforeFineUpload;
  const values = checks({ renderer, baseline, coarseProjection, fineProjection, legacySurface,
    coarseStageSurface, coarseSurface, fineStageSurface, fineSurface, farSurface,
    coarseGpuResources, fineGpuResources, firstResidents, replacementResidents,
    coarseFrame, fineFrame, farFrame, coarseFrameResources, fineStageResources,
    fineFrameResources, farFrameResources, retiredBefore, retiredAfter, retiredAfterCleanup,
    diagnosticsBefore, coarseLeaseHeldDuringFineStage, leasesSwappedAtFineFrame, gpuErrors, restored });
  const success = failure === undefined && evaluatePbrPartialLodResidencyProbe(values);
  return Object.freeze({ action: "pbr-partial-lod-residency", success, ...values,
    ...(failure ? { failure } : {}) });
}

interface CheckInput {
  readonly renderer: PbrRenderer; readonly baseline: number;
  readonly coarseProjection: ResidentPacketProjection | undefined;
  readonly fineProjection: ResidentPacketProjection | undefined;
  readonly legacySurface: PartialLodSurfaceEvidence; readonly coarseStageSurface: PartialLodSurfaceEvidence;
  readonly coarseSurface: PartialLodSurfaceEvidence; readonly fineStageSurface: PartialLodSurfaceEvidence;
  readonly fineSurface: PartialLodSurfaceEvidence; readonly farSurface: PartialLodSurfaceEvidence;
  readonly coarseGpuResources: number; readonly fineGpuResources: number;
  readonly firstResidents: readonly string[]; readonly replacementResidents: readonly string[];
  readonly coarseFrame: FrameMetrics | undefined; readonly fineFrame: FrameMetrics | undefined;
  readonly farFrame: FrameMetrics | undefined;
  readonly coarseFrameResources: number; readonly fineStageResources: number;
  readonly fineFrameResources: number; readonly farFrameResources: number;
  readonly retiredBefore: number; readonly retiredAfter: number; readonly retiredAfterCleanup: number;
  readonly diagnosticsBefore: number; readonly gpuErrors: readonly string[];
  readonly coarseLeaseHeldDuringFineStage: boolean; readonly leasesSwappedAtFineFrame: boolean;
  readonly restored: boolean;
}
function checks(input: CheckInput): ProbeChecks {
  const coarseLeft = input.coarseSurface.redCentroidX !== null && input.coarseSurface.redCentroidX < 0.495;
  const fineRight = input.fineSurface.redCentroidX !== null && input.fineSurface.redCentroidX > 0.505;
  const farLeft = input.farSurface.redCentroidX !== null && input.farSurface.redCentroidX < 0.495;
  const draws = Object.freeze({ coarse: draw(input.coarseFrame), fine: draw(input.fineFrame), far: draw(input.farFrame) });
  const uploads = Object.freeze({ coarseGpuResources: input.coarseGpuResources,
    fineGpuResources: input.fineGpuResources, firstResidents: Object.freeze([...input.firstResidents]),
    replacementResidents: Object.freeze([...input.replacementResidents]) });
  const resources = Object.freeze({ baseline: input.baseline, coarseFrame: input.coarseFrameResources,
    fineStage: input.fineStageResources, fineFrame: input.fineFrameResources, farFrame: input.farFrameResources,
    afterCleanup: input.renderer.session.resourceCount, retiredBeforeFineFrame: input.retiredBefore,
    retiredAfterFineFrame: input.retiredAfter, retiredAfterCleanup: input.retiredAfterCleanup,
    rendererCacheDelta: input.renderer.session.resourceCount - input.baseline });
  const surfaces = Object.freeze({ legacy: input.legacySurface, coarseStage: input.coarseStageSurface,
    coarse: input.coarseSurface, fineStage: input.fineStageSurface, fine: input.fineSurface, far: input.farSurface });
  return Object.freeze({ coarseOnlyActuallyDrew: !!coarseLeft && input.coarseSurface.redPixels > 16
      && input.firstResidents.join() === "geometry:coarse" && draws.coarse.lodSelectionBatches === 1,
    coarseStagePreservedLegacyFrame: input.legacySurface?.checksum === input.coarseStageSurface?.checksum,
    fineStagePreservedCoarseFrameAndLease: input.coarseSurface?.checksum === input.fineStageSurface?.checksum
      && input.coarseLeaseHeldDuringFineStage,
    finePublishedAtFrameBoundary: !!fineRight && input.fineSurface.redPixels > 16
      && input.leasesSwappedAtFineFrame,
    farViewSelectedCoarse: !!farLeft && input.farSurface.redPixels > 4,
    uploadsExactlyOnce: input.coarseGpuResources === 2 && input.fineGpuResources === 2
      && input.replacementResidents.join() === "geometry:coarse,geometry:fine",
    leaseRetirementOrdered: input.retiredBefore > 0 && input.retiredAfter === input.retiredBefore
      && input.retiredAfterCleanup === 0 && input.leasesSwappedAtFineFrame,
    streamedResourcesReleased: input.restored && input.retiredAfterCleanup === 0
      && input.fineProjection?.released === true && input.renderer.session.state === "ready",
    rendererCacheBounded: input.renderer.session.resourceCount === input.baseline,
    gpuErrorScopesClean: input.gpuErrors.length === 0,
    deviceDiagnosticsClean: input.renderer.session.diagnostics.length === input.diagnosticsBefore,
    nonFallbackAdapter: input.renderer.session.adapterInfo?.isFallbackAdapter === false,
    surfaces, uploads, resources, draws, gpuErrors: Object.freeze([...input.gpuErrors]) });
}

function draw(frame: FrameMetrics | undefined) { return Object.freeze({ drawCalls: frame?.drawCalls ?? -1,
  triangles: frame?.triangles ?? -1, lodSelectionBatches: frame?.lodSelectionBatches ?? -1,
  lodIndirectDraws: frame?.lodIndirectDraws ?? -1 }); }
function residentIds(runtime: GpuRenderResidencyRuntime): string[] {
  return runtime.snapshot().map(value => `${value.kind}:${value.id}`).sort();
}
async function renderSurface(renderer: PbrRenderer, canvas: HTMLCanvasElement, view: RenderView):
Promise<{ readonly frame: FrameMetrics; readonly surface: PartialLodSurfaceEvidence }> {
  const frame = requireFrame(renderer.render(view));
  const surface = await readPartialLodSurface(renderer.session, canvas);
  return Object.freeze({ frame, surface });
}
function requireFrame(frame: FrameMetrics | undefined): FrameMetrics {
  if (!frame) throw new Error("Partial LOD probe could not encode a surface frame."); return frame;
}
function request(values: readonly GpuRenderResidencyRequest[], id: string): GpuRenderResidencyRequest {
  const value = values.find(candidate => candidate.kind === "geometry" && candidate.id === id);
  if (!value) throw new Error(`Partial LOD probe request is unavailable: ${id}.`); return value;
}

function lodPacket(): RenderPacket {
  return { geometries: [disc("fine", 0.48, 0.34, 8), disc("coarse", -0.48, 0.32, 2)],
    materials: [{ id: "lod-red", baseColor: [0, 0, 0], metallic: 0, roughness: 1,
      emissiveFactor: [1, 0.015, 0.01], emissiveStrength: 8, doubleSided: true }],
    instances: [{ id: "lod-object", geometry: "fine", material: "lod-red",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.8, 0, 1], lod: { levels: [
        { geometry: "fine", minProjectedDiameterPixels: 150, geometricError: 0 },
        { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } }] };
}
function disc(id: string, x: number, radius: number, triangles: number): GeometryResource {
  const vertices = [x, 0, 0, 0, 0, 1];
  if (triangles === 2) {
    vertices.push(x - radius, -radius, 0, 0, 0, 1, x + radius, -radius, 0, 0, 0, 1,
      x + radius, radius, 0, 0, 0, 1, x - radius, radius, 0, 0, 0, 1);
    return { id, revision: 1, vertices: new Float32Array(vertices), indices: new Uint32Array([1, 2, 3, 1, 3, 4]) };
  }
  for (let i = 0; i < triangles; i++) { const angle = i * Math.PI * 2 / triangles;
    vertices.push(x + Math.cos(angle) * radius, Math.sin(angle) * radius, 0, 0, 0, 1); }
  const indices: number[] = [];
  for (let i = 0; i < triangles; i++) indices.push(0, i + 1, (i + 1) % triangles + 1);
  return { id, revision: 1, vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
function legacyPacket(): RenderPacket {
  const mesh = sphereMesh(8, 6);
  return { geometries: [{ id: "partial-lod-legacy", revision: 1, ...mesh }],
    materials: [{ id: "partial-lod-blue", baseColor: [0, 0, 0], metallic: 0, roughness: 1,
      emissiveFactor: [0.01, 0.02, 1], emissiveStrength: 8 }],
    instances: [{ id: "partial-lod-legacy-instance", geometry: "partial-lod-legacy",
      material: "partial-lod-blue", transform: [0.45, 0, 0, 0, 0, 0.45, 0, 0,
        0, 0, 0.45, 0, 0, 0.8, 0, 1] }] };
}
function nearView(canvas: HTMLCanvasElement): RenderView { return probeView(canvas, 3.4); }
function farView(canvas: HTMLCanvasElement): RenderView { return probeView(canvas, 20); }
function probeView(canvas: HTMLCanvasElement, z: number): RenderView {
  return { width: canvas.clientWidth, height: canvas.clientHeight, pixelRatio: devicePixelRatio,
    eye: [0, 0.8, z], target: [0, 0.8, 0], up: [0, 1, 0], extent: 3,
    near: 0.1, far: 60, background: [0.001, 0.001, 0.001], floor: [0.002, 0.002, 0.002],
    exposure: 1, roughness: 1 };
}
function emptySurface(): PartialLodSurfaceEvidence {
  return Object.freeze({ width: 0, height: 0, redPixels: 0, redCentroidX: null,
    redCentroidY: null, peakRgba: Object.freeze([0, 0, 0, 0] as const), checksum: "" });
}
