/// <reference types="@webgpu/types" />
import {
  prepareRenderPacket,
  type DecodedTexture,
  type GeometryResource,
  type RenderPacket,
} from "@bim-studio/deep-engine";
import {
  createPacketResidencyDomain,
  createPbrResidencyStream,
  sphereMesh,
  type DeviceSession,
  type GpuRenderResidencyTelemetrySnapshot,
  type PacketResidencyDomain,
  type PacketResidencyTicket,
  type PbrRenderer,
  type PbrResidencyFrameTarget,
  type RenderView,
  type ResidentPacketProjection,
} from "@bim-studio/deep-engine/webgpu";

type Rgba = readonly [number, number, number, number];
interface ResourceEvidence { readonly baseline: number; readonly firstStage: number;
  readonly firstFrame: number; readonly replacementStage: number;
  readonly replacementFrame: number; readonly afterCleanup: number }
interface RetiredEvidence { readonly replacementStage: number;
  readonly replacementFrame: number; readonly afterCleanup: number }

export interface PbrResidencyStreamProbeResult {
  readonly action: "pbr-residency-stream";
  readonly success: boolean;
  readonly firstStagePreservedLegacyFrame: boolean;
  readonly firstFramePublishedAtBoundary: boolean;
  readonly sameFrameLatestWon: boolean;
  readonly replacementStagePreservedFrameAndLease: boolean;
  readonly replacementFramePublishedAndRetiredLease: boolean;
  readonly uploadsExactlyOnce: boolean;
  readonly projectionsReleased: boolean;
  readonly resourcesReturnedToBaseline: boolean;
  readonly gpuErrorScopesClean: boolean;
  readonly deviceDiagnosticsClean: boolean;
  readonly nonFallbackAdapter: boolean;
  readonly pixels: Readonly<{ legacy: Rgba | null; firstStage: Rgba | null;
    first: Rgba | null; replacementStage: Rgba | null; replacement: Rgba | null }>;
  readonly telemetry: Readonly<{ first: GpuRenderResidencyTelemetrySnapshot | null;
    replacement: GpuRenderResidencyTelemetrySnapshot | null }>;
  readonly resources: ResourceEvidence;
  readonly retiredBytes: RetiredEvidence;
  readonly stagedProjectionCount: number;
  readonly supersededCode: string | null;
  readonly gpuErrors: readonly string[];
  readonly failure?: string;
}

type ProbeChecks = Omit<PbrResidencyStreamProbeResult, "action" | "success" | "failure">;
export function evaluatePbrResidencyStreamProbe(value: ProbeChecks): boolean {
  return value.firstStagePreservedLegacyFrame && value.firstFramePublishedAtBoundary
    && value.sameFrameLatestWon && value.replacementStagePreservedFrameAndLease
    && value.replacementFramePublishedAndRetiredLease && value.uploadsExactlyOnce
    && value.projectionsReleased && value.resourcesReturnedToBaseline
    && value.gpuErrorScopesClean && value.deviceDiagnosticsClean && value.nonFallbackAdapter;
}

/** Exercises the production domain, working set, stream, and renderer on one real surface. */
export async function verifyPbrResidencyStream(renderer: PbrRenderer,
  canvas: HTMLCanvasElement): Promise<PbrResidencyStreamProbeResult> {
  const session = renderer.session, diagnosticsBefore = session.diagnostics.length;
  if (session.state !== "ready") throw new Error("PBR residency stream probe requires a ready renderer.");
  const legacy = legacyPacket(), prepared = prepareRenderPacket(streamPacket());
  const gpuErrors: string[] = [], projections: ResidentPacketProjection[] = [];
  let domain: PacketResidencyDomain | undefined, ticket: PacketResidencyTicket | undefined;
  let stream: ReturnType<typeof createPbrResidencyStream> | undefined;
  let firstTelemetry: GpuRenderResidencyTelemetrySnapshot | null = null;
  let replacementTelemetry: GpuRenderResidencyTelemetrySnapshot | null = null;
  let legacyPixel: Rgba | null = null, firstStagePixel: Rgba | null = null, firstPixel: Rgba | null = null;
  let replacementStagePixel: Rgba | null = null, replacementPixel: Rgba | null = null;
  let baseline = -1, firstStageResources = -1, firstFrameResources = -1;
  let replacementStageResources = -1, replacementFrameResources = -1, afterCleanup = -1;
  let retiredAtStage = -1, retiredAtFrame = -1, retiredAfterCleanup = -1;
  let supersededCode: string | null = null, failure: string | undefined;
  let restored = false, sameFrameLatestWon = false;
  let firstHeldAtStage = false, bothHeldAtReplacementStage = false;
  let firstReleasedAtReplacementFrame = false, replacementHeldAtReplacementFrame = false;
  for (const filter of ["validation", "out-of-memory", "internal"] as const) session.device.pushErrorScope(filter);
  try {
    await renderer.setPacketValidated(legacy);
    session.context.configure({ device: session.device, format: session.format, alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    requireFrame(renderer.render(probeView(canvas)));
    baseline = session.resourceCount;

    domain = createPacketResidencyDomain(session,
      { maxResidentBytes: 1024 * 1024, maxUploadBytesPerFrame: 1024 * 1024 },
      { maxConcurrentUploads: 2 });
    ticket = domain.registerPacket("lab-pbr-residency-stream", prepared);
    const target: PbrResidencyFrameTarget = {
      cancelResidentPacketStage: () => renderer.cancelResidentPacketStage(),
      async stageResidentPacketValidated(projection, signal) {
        projections.push(projection);
        await renderer.stageResidentPacketValidated(projection, signal);
      },
    };
    stream = createPbrResidencyStream(domain, ticket, prepared, target);
    requireFrame(renderer.render(probeView(canvas)));
    const legacyRead = surfacePixel(session, canvas);
    const firstStage = stream.stage({ frame: 21_001, demands: [],
      textureMipLevels: new Map([["stream-emissive", 1]]) });
    const firstStageRead = surfacePixel(session, canvas);
    await firstStage; [legacyPixel, firstStagePixel] = await Promise.all([legacyRead, firstStageRead]);
    firstStageResources = session.resourceCount; firstTelemetry = domain.telemetrySnapshot();
    const firstProjection = projections[0];
    firstHeldAtStage = firstProjection !== undefined && !firstProjection.released;

    requireFrame(renderer.render(probeView(canvas)));
    const firstRead = surfacePixel(session, canvas); firstFrameResources = session.resourceCount;
    const stale = stream.stage({ frame: 21_002, demands: [],
      textureMipLevels: new Map([["stream-emissive", 1]]) });
    const winner = stream.stage({ frame: 21_002, demands: [],
      textureMipLevels: new Map([["stream-emissive", 2]]) });
    const replacementStageRead = surfacePixel(session, canvas);
    try { await stale; }
    catch (error) { supersededCode = errorCode(error); }
    await winner; [firstPixel, replacementStagePixel] = await Promise.all([firstRead, replacementStageRead]);
    replacementStageResources = session.resourceCount; retiredAtStage = domain.retiredBytes;
    replacementTelemetry = domain.telemetrySnapshot();
    bothHeldAtReplacementStage = firstProjection !== undefined && !firstProjection.released
      && projections[1] !== undefined && !projections[1].released;
    sameFrameLatestWon = supersededCode === "superseded" && stream.latestFrame === 21_002
      && projections.length === 2 && replacementTelemetry.lastAppliedFrame?.frame === 21_002;

    requireFrame(renderer.render(probeView(canvas)));
    replacementPixel = await surfacePixel(session, canvas);
    replacementFrameResources = session.resourceCount; retiredAtFrame = domain.retiredBytes;
    if (!firstProjection) throw new Error("First streamed projection was not staged.");
    firstReleasedAtReplacementFrame = firstProjection.released;
    replacementHeldAtReplacementFrame = projections[1] !== undefined && !projections[1].released;
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    try { stream?.dispose(); }
    catch (error) { failure ??= `Stream cleanup failed: ${message(error)}`; }
    try {
      await renderer.setPacketValidated(legacy); await renderer.validateFrame(probeView(canvas)); restored = true;
    } catch (error) { failure ??= `Renderer cleanup failed: ${message(error)}`; }
    try { if (domain && ticket && !domain.disposed) domain.unregister(ticket); }
    catch (error) { failure ??= `Ticket cleanup failed: ${message(error)}`; }
    try { domain?.dispose(); }
    catch (error) { failure ??= `Domain cleanup failed: ${message(error)}`; }
    retiredAfterCleanup = domain?.retiredBytes ?? 0; afterCleanup = session.resourceCount;
    for (let index = 0; index < 3; index++) try {
      const error = await session.device.popErrorScope(); if (error) gpuErrors.push(error.message);
    } catch (error) { gpuErrors.push(message(error)); }
  }

  const firstStagePreservedLegacyFrame = samePixel(legacyPixel, firstStagePixel)
    && dominant(legacyPixel, 0) && firstHeldAtStage;
  const firstFramePublishedAtBoundary = dominant(firstPixel, 1) && changed(legacyPixel, firstPixel);
  const replacementStagePreservedFrameAndLease = samePixel(firstPixel, replacementStagePixel)
    && dominant(replacementStagePixel, 1) && retiredAtStage > 0
    && bothHeldAtReplacementStage;
  const replacementFramePublishedAndRetiredLease = dominant(replacementPixel, 2)
    && changed(firstPixel, replacementPixel) && firstReleasedAtReplacementFrame
    && replacementHeldAtReplacementFrame && retiredAtFrame === 0;
  const uploadsExactlyOnce = firstTelemetry?.lastAppliedFrame?.uploadedResourceCount === 2
    && replacementTelemetry?.lastAppliedFrame?.uploadedResourceCount === 1
    && levels(firstTelemetry).join(",") === "geometry:stream-geometry:0,texture:stream-emissive:1"
    && levels(replacementTelemetry).join(",") === "geometry:stream-geometry:0,texture:stream-emissive:2";
  const values: ProbeChecks = Object.freeze({ firstStagePreservedLegacyFrame,
    firstFramePublishedAtBoundary, sameFrameLatestWon, replacementStagePreservedFrameAndLease,
    replacementFramePublishedAndRetiredLease, uploadsExactlyOnce,
    projectionsReleased: projections.length === 2 && projections.every(value => value.released),
    resourcesReturnedToBaseline: restored && baseline >= 0 && afterCleanup === baseline,
    gpuErrorScopesClean: gpuErrors.length === 0,
    deviceDiagnosticsClean: session.diagnostics.length === diagnosticsBefore,
    nonFallbackAdapter: session.adapterInfo?.isFallbackAdapter === false,
    pixels: Object.freeze({ legacy: legacyPixel, firstStage: firstStagePixel, first: firstPixel,
      replacementStage: replacementStagePixel, replacement: replacementPixel }),
    telemetry: Object.freeze({ first: firstTelemetry, replacement: replacementTelemetry }),
    resources: Object.freeze({ baseline, firstStage: firstStageResources, firstFrame: firstFrameResources,
      replacementStage: replacementStageResources, replacementFrame: replacementFrameResources, afterCleanup }),
    retiredBytes: Object.freeze({ replacementStage: retiredAtStage,
      replacementFrame: retiredAtFrame, afterCleanup: retiredAfterCleanup }),
    stagedProjectionCount: projections.length, supersededCode, gpuErrors: Object.freeze(gpuErrors) });
  const success = failure === undefined && evaluatePbrResidencyStreamProbe(values);
  return Object.freeze({ action: "pbr-residency-stream", success, ...values,
    ...(failure ? { failure } : {}) });
}

function streamPacket(): RenderPacket {
  const mesh = sphereMesh(16, 10), geometry: GeometryResource = { id: "stream-geometry", revision: 1,
    ...mesh, uv0: new Float32Array(mesh.vertices.length / 3).fill(0.5) };
  const texture: DecodedTexture = { id: "stream-emissive", revision: 1, semantic: "emissive",
    width: 4, height: 4, data: solid(4, [255, 0, 0, 255]), mipmaps: [
      { width: 2, height: 2, data: solid(2, [0, 255, 0, 255]) },
      { width: 1, height: 1, data: solid(1, [0, 0, 255, 255]) }],
    sampler: { magFilter: "nearest", minFilter: "nearest", mipmapFilter: "nearest" } };
  return { geometries: [geometry], textures: [texture], materials: [{ id: "stream-material",
    baseColor: [0, 0, 0], metallic: 0, roughness: 1, emissiveFactor: [1, 1, 1], emissiveStrength: 8,
    emissiveTexture: { texture: texture.id } }], instances: [{ id: "stream-instance",
    geometry: geometry.id, material: "stream-material",
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.8, 0, 1] }] };
}
function legacyPacket(): RenderPacket {
  const mesh = sphereMesh(16, 10);
  return { geometries: [{ id: "stream-legacy", revision: 1, ...mesh }],
    materials: [{ id: "stream-legacy-material", baseColor: [0, 0, 0], metallic: 0, roughness: 1,
      emissiveFactor: [1, 0, 0], emissiveStrength: 8 }], instances: [{ id: "stream-legacy-instance",
      geometry: "stream-legacy", material: "stream-legacy-material",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.8, 0, 1] }] };
}
function solid(size: number, rgba: Rgba): Uint8Array {
  return new Uint8Array(Array.from({ length: size * size }, () => rgba).flat());
}
function probeView(canvas: HTMLCanvasElement): RenderView {
  return { width: canvas.clientWidth, height: canvas.clientHeight, pixelRatio: devicePixelRatio,
    eye: [0, 0.8, 3.4], target: [0, 0.8, 0], up: [0, 1, 0], extent: 2,
    background: [0.002, 0.002, 0.002], floor: [0.003, 0.003, 0.003], exposure: 1, roughness: 1 };
}

async function surfacePixel(session: DeviceSession, canvas: HTMLCanvasElement): Promise<Rgba> {
  const buffer = session.device.createBuffer({ label: "Deep residency stream surface readback", size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = session.device.createCommandEncoder({ label: "Deep residency stream surface copy" });
    encoder.copyTextureToBuffer({ texture: session.context.getCurrentTexture(),
      origin: [Math.max(0, Math.floor(canvas.width / 2)), Math.max(0, Math.floor(canvas.height / 2))] },
    { buffer, bytesPerRow: 256 }, [1, 1]);
    session.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const bytes = Array.from(new Uint8Array(buffer.getMappedRange(), 0, 4)); buffer.unmap();
    return Object.freeze((session.format.startsWith("bgra")
      ? [bytes[2]!, bytes[1]!, bytes[0]!, bytes[3]!] : bytes) as [number, number, number, number]);
  } finally { if (buffer.mapState === "mapped") buffer.unmap(); buffer.destroy(); }
}
function levels(value: GpuRenderResidencyTelemetrySnapshot | null): string[] {
  return value ? value.resources.map(item => `${item.kind}:${item.id}:${item.level}`).sort() : [];
}
function dominant(pixel: Rgba | null, channel: 0 | 1 | 2): boolean {
  if (!pixel) return false; const others = [0, 1, 2].filter(value => value !== channel);
  return pixel[channel] >= 96 && others.every(value => pixel[channel] - pixel[value]! >= 32);
}
function samePixel(left: Rgba | null, right: Rgba | null): boolean {
  return !!left && !!right && left.every((value, index) => Math.abs(value - right[index]!) <= 2);
}
function changed(left: Rgba | null, right: Rgba | null): boolean {
  return !!left && !!right && left.slice(0, 3).reduce((sum, value, index) =>
    sum + Math.abs(value - right[index]!), 0) >= 96;
}
function errorCode(error: unknown): string { return typeof error === "object" && error !== null
  && "code" in error ? String(error.code) : "unknown"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requireFrame(frame: unknown): void { if (!frame) throw new Error("PBR residency stream frame failed."); }
