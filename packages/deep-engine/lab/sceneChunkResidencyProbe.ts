/// <reference types="@webgpu/types" />
import { prepareRenderPacket } from "@bim-studio/deep-engine";
import { createSceneChunkResidency, stageSceneChunkFrame, type GpuRenderResidencyTelemetrySnapshot,
  type PbrRenderer, type ResidentPacketProjection,
  type ResidentSceneChunkFrame } from "@bim-studio/deep-engine/webgpu";
import { dominantChunkPixel, readSceneChunkPixels, sceneChunkLegacyPacket,
  sceneChunkProbePacket, sceneChunkProbeView, type ChunkProbeRgba } from "./sceneChunkResidencyProbeSupport.js";

interface ChunkResourceEvidence { readonly baseline: number; readonly first: number;
  readonly promoted: number; readonly exited: number; readonly afterCleanup: number }
interface ChunkRetiredEvidence { readonly exited: number; readonly afterRelease: number;
  readonly afterCleanup: number }

export interface SceneChunkResidencyProbeResult {
  readonly action: "scene-chunk-residency";
  readonly success: boolean;
  readonly sameFrameLatestWon: boolean;
  readonly mergedSharedUploadOnce: boolean;
  readonly visibleChunksDrew: boolean;
  readonly sameFrameChunkCounts: readonly number[];
  readonly prefetchHadNoProjection: boolean;
  readonly prefetchPromotionReusedUploads: boolean;
  readonly exitedChunkLeaseRetired: boolean;
  readonly resourcesReturnedToBaseline: boolean;
  readonly projectionsReleased: boolean;
  readonly gpuErrorScopesClean: boolean;
  readonly deviceDiagnosticsClean: boolean;
  readonly nonFallbackAdapter: boolean;
  readonly pixels: Readonly<{ west: ChunkProbeRgba | null; east: ChunkProbeRgba | null;
    ahead: ChunkProbeRgba | null }>;
  readonly telemetry: Readonly<{ first: GpuRenderResidencyTelemetrySnapshot | null;
    promoted: GpuRenderResidencyTelemetrySnapshot | null;
    exited: GpuRenderResidencyTelemetrySnapshot | null;
    sameFrame: GpuRenderResidencyTelemetrySnapshot | null;
    final: GpuRenderResidencyTelemetrySnapshot | null }>;
  readonly resources: ChunkResourceEvidence;
  readonly retiredBytes: ChunkRetiredEvidence;
  readonly submittedFrames: Readonly<{ firstDelta: number; final: number }>;
  readonly supersededCode: string | null;
  readonly gpuErrors: readonly string[];
  readonly failure?: string;
}

type ProbeChecks = Omit<SceneChunkResidencyProbeResult, "action" | "success" | "failure">;
export function evaluateSceneChunkResidencyProbe(value: ProbeChecks): boolean {
  return value.sameFrameLatestWon && value.mergedSharedUploadOnce && value.visibleChunksDrew
    && value.prefetchHadNoProjection && value.prefetchPromotionReusedUploads
    && value.exitedChunkLeaseRetired && value.resourcesReturnedToBaseline
    && value.projectionsReleased && value.gpuErrorScopesClean
    && value.deviceDiagnosticsClean && value.nonFallbackAdapter
    && value.sameFrameChunkCounts.length === 2 && value.sameFrameChunkCounts[0] === 2 && value.sameFrameChunkCounts[1] === 3
    && value.submittedFrames.firstDelta === 1 && value.submittedFrames.final === 6;
}

/** Exercises multi-ticket scene residency, actual PBR draw, retirement, and cleanup on one real device. */
export async function verifySceneChunkResidency(renderer: PbrRenderer,
  canvas: HTMLCanvasElement): Promise<SceneChunkResidencyProbeResult> {
  const session = renderer.session, diagnosticsBefore = session.diagnostics.length;
  if (session.state !== "ready") throw new Error("Scene chunk residency probe requires a ready renderer.");
  const legacy = sceneChunkLegacyPacket();
  const west = prepareRenderPacket(sceneChunkProbePacket("west"));
  const east = prepareRenderPacket(sceneChunkProbePacket("east"));
  const ahead = prepareRenderPacket(sceneChunkProbePacket("ahead"));
  const gpuErrors: string[] = [], frames: ResidentSceneChunkFrame[] = [];
  let scene: ReturnType<typeof createSceneChunkResidency> | undefined;
  let firstTelemetry: GpuRenderResidencyTelemetrySnapshot | null = null;
  let promotedTelemetry: GpuRenderResidencyTelemetrySnapshot | null = null;
  let exitedTelemetry: GpuRenderResidencyTelemetrySnapshot | null = null;
  let sameFrameTelemetry: GpuRenderResidencyTelemetrySnapshot | null = null;
  let finalTelemetry: GpuRenderResidencyTelemetrySnapshot | null = null;
  let westPixel: ChunkProbeRgba | null = null, eastPixel: ChunkProbeRgba | null = null;
  let aheadPixel: ChunkProbeRgba | null = null, supersededCode: string | null = null;
  let baseline = -1, firstResources = -1, promotedResources = -1, exitedResources = -1;
  let afterCleanup = -1, retiredExited = -1, retiredAfterRelease = -1, retiredAfterCleanup = -1;
  let firstSubmissionDelta = -1, finalSubmissionCount = -1;
  let sharedHandle = false, prefetchAbsent = false, allReleased = false, restored = false;
  let failure: string | undefined;
  const sameFrameChunkCounts: number[] = [];
  for (const filter of ["validation", "out-of-memory", "internal"] as const) session.device.pushErrorScope(filter);
  try {
    await renderer.setPacketValidated(legacy);
    session.context.configure({ device: session.device, format: session.format, alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    requireFrame(renderer.render(sceneChunkProbeView(canvas))); baseline = session.resourceCount;
    scene = createSceneChunkResidency(session,
      { maxResidentBytes: 16 * 1024 * 1024, maxUploadBytesPerFrame: 16 * 1024 * 1024 },
      { executor: { maxConcurrentUploads: 3 } });
    scene.registerChunk("west", west); scene.registerChunk("east", east); scene.registerChunk("ahead", ahead);

    const submittedBefore = scene.submittedFrameCount;
    const first = await scene.update({ frame: 31_001,
      chunks: [visible("west"), visible("east"), prefetch("ahead")] });
    firstSubmissionDelta = scene.submittedFrameCount - submittedBefore; frames.push(first);
    firstTelemetry = scene.telemetrySnapshot(); firstResources = session.resourceCount;
    prefetchAbsent = first.chunk("ahead") === undefined && first.chunks.length === 2;
    sharedHandle = first.chunk("west")?.texture("chunk-shared-white")?.texture
      === first.chunk("east")?.texture("chunk-shared-white")?.texture;
    await stageSceneChunkFrame(renderer, first);
    requireFrame(renderer.render(sceneChunkProbeView(canvas))); sameFrameChunkCounts.push(first.chunks.length);
    [westPixel, eastPixel] = await readSceneChunkPixels(session, canvas, [-1, 1]) as [ChunkProbeRgba, ChunkProbeRgba];

    const promoted = await scene.update({ frame: 31_002,
      chunks: [visible("west"), visible("east"), visible("ahead")] });
    frames.push(promoted); promotedTelemetry = scene.telemetrySnapshot();
    promotedResources = session.resourceCount;
    await stageSceneChunkFrame(renderer, promoted);
    requireFrame(renderer.render(sceneChunkProbeView(canvas))); sameFrameChunkCounts.push(promoted.chunks.length);
    const promotedPixels = await readSceneChunkPixels(session, canvas, [-1, 1, 0]);
    aheadPixel = promotedPixels[2]!;
    if (!dominantChunkPixel(promotedPixels[0]!, 0) || !dominantChunkPixel(promotedPixels[1]!, 1)) throw new Error("Promoted frame lost existing visible chunks.");

    const exited = await scene.update({ frame: 31_003, chunks: [visible("west")] });
    frames.push(exited); exitedTelemetry = scene.telemetrySnapshot(); exitedResources = session.resourceCount;
    retiredExited = scene.telemetrySnapshot().retiredBytes;
    await renderer.setPacketValidated(legacy); await renderer.validateFrame(sceneChunkProbeView(canvas));
    for (const frame of frames) frame.release(); retiredAfterRelease = scene.telemetrySnapshot().retiredBytes;
    const stale = scene.update({ frame: 31_004, chunks: [visible("west")] });
    const winner = scene.update({ frame: 31_004, chunks: [] });
    try { await stale; } catch (error) { supersededCode = errorCode(error); }
    const empty = await winner; frames.push(empty); empty.release();
    sameFrameTelemetry = scene.telemetrySnapshot();
    const cleanup = await scene.update({ frame: 31_005, chunks: [] }); frames.push(cleanup); cleanup.release();
    finalSubmissionCount = scene.submittedFrameCount;
    scene.unregisterChunk("west"); scene.unregisterChunk("east"); scene.unregisterChunk("ahead");
    finalTelemetry = scene.telemetrySnapshot(); scene.dispose(); retiredAfterCleanup = scene.telemetrySnapshot().retiredBytes;
    await renderer.setPacketValidated(legacy); await renderer.validateFrame(sceneChunkProbeView(canvas));
    restored = true; afterCleanup = session.resourceCount;
    allReleased = frames.every(frame => frame.released);
  } catch (error) { failure = message(error); }
  finally {
    try { await renderer.setPacketValidated(legacy); await renderer.validateFrame(sceneChunkProbeView(canvas)); }
    catch (error) { failure ??= `Renderer cleanup failed: ${message(error)}`; }
    for (const frame of frames) try { frame.release(); }
    catch (error) { failure ??= `Projection cleanup failed: ${message(error)}`; }
    try { scene?.dispose(); } catch (error) { failure ??= `Scene cleanup failed: ${message(error)}`; }
    retiredAfterCleanup = scene?.telemetrySnapshot().retiredBytes ?? retiredAfterCleanup;
    afterCleanup = session.resourceCount;
    for (let index = 0; index < 3; index++) try {
      const error = await session.device.popErrorScope(); if (error) gpuErrors.push(error.message);
    } catch (error) { gpuErrors.push(message(error)); }
  }

  const sameFrameLatestWon = supersededCode === "superseded"
    && sameFrameTelemetry?.lastAppliedFrame?.frame === 31_004
    && sameFrameTelemetry.lastAppliedFrame.requestedResourceCount === 0;
  const mergedSharedUploadOnce = firstSubmissionDelta === 1 && sharedHandle
    && firstTelemetry?.lastAppliedFrame?.requestedResourceCount === 5
    && firstTelemetry.lastAppliedFrame.uploadedResourceCount === 5
    && firstTelemetry.resources.filter(value => value.id === "chunk-shared-white").length === 1;
  const visibleChunksDrew = dominantChunkPixel(westPixel, 0) && dominantChunkPixel(eastPixel, 1);
  const prefetchPromotionReusedUploads = dominantChunkPixel(aheadPixel, 2)
    && promotedTelemetry?.lastAppliedFrame?.uploadedResourceCount === 0;
  const exitedChunkLeaseRetired = retiredExited > 0 && retiredAfterRelease === 0
    && exitedTelemetry?.resources.map(value => value.id).sort().join(",")
      === "chunk-shared-white,chunk-west-geometry";
  const values: ProbeChecks = Object.freeze({ sameFrameLatestWon, mergedSharedUploadOnce,
    visibleChunksDrew, sameFrameChunkCounts: Object.freeze(sameFrameChunkCounts), prefetchHadNoProjection: prefetchAbsent, prefetchPromotionReusedUploads,
    exitedChunkLeaseRetired, resourcesReturnedToBaseline: restored && baseline >= 0
      && afterCleanup === baseline && finalTelemetry?.residentBytes === 0 && finalTelemetry.retiredBytes === 0
      && finalTelemetry.registeredResourceCount === 0 && retiredAfterCleanup === 0,
    projectionsReleased: allReleased, gpuErrorScopesClean: gpuErrors.length === 0,
    deviceDiagnosticsClean: session.diagnostics.length === diagnosticsBefore,
    nonFallbackAdapter: session.adapterInfo?.isFallbackAdapter === false,
    pixels: Object.freeze({ west: westPixel, east: eastPixel, ahead: aheadPixel }),
    telemetry: Object.freeze({ first: firstTelemetry, promoted: promotedTelemetry,
      exited: exitedTelemetry, sameFrame: sameFrameTelemetry, final: finalTelemetry }),
    resources: Object.freeze({ baseline, first: firstResources, promoted: promotedResources,
      exited: exitedResources, afterCleanup }),
    retiredBytes: Object.freeze({ exited: retiredExited, afterRelease: retiredAfterRelease,
      afterCleanup: retiredAfterCleanup }),
    submittedFrames: Object.freeze({ firstDelta: firstSubmissionDelta, final: finalSubmissionCount }),
    supersededCode, gpuErrors: Object.freeze(gpuErrors) });
  const success = failure === undefined && evaluateSceneChunkResidencyProbe(values);
  return Object.freeze({ action: "scene-chunk-residency", success, ...values,
    ...(failure ? { failure } : {}) });
}

function visible(key: string) { return Object.freeze({ key, mode: "visible" as const, demands: Object.freeze([]) }); }
function prefetch(key: string) { return Object.freeze({ key, mode: "prefetch" as const, demands: Object.freeze([]) }); }
function errorCode(error: unknown): string { return typeof error === "object" && error !== null
  && "code" in error ? String(error.code) : "unknown"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requireFrame(frame: unknown): void { if (!frame) throw new Error("Scene chunk residency frame failed."); }
