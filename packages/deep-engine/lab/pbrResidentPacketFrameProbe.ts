/// <reference types="@webgpu/types" />
import {
  prepareRenderPacket,
  type DecodedTexture,
  type GeometryResource,
  type RenderPacket,
} from "@bim-studio/deep-engine";
import {
  createPacketResidencyLoader,
  GpuRenderResidencyRuntime,
  sphereMesh,
  type DeviceSession,
  type PbrRenderer,
  type RenderView,
  type ResidentPacketProjection,
} from "@bim-studio/deep-engine/webgpu";

type Rgba = readonly [number, number, number, number];
type UploadCounts = Readonly<{ geometry: number; texture: number }>;

export interface PbrResidentPacketFrameProbeResult {
  readonly action: "pbr-resident-packet-frame-boundary";
  readonly success: boolean;
  readonly firstStagePreservedOldFrame: boolean;
  readonly firstFramePublishedResidentPacket: boolean;
  readonly replacementStagePreservedOldFrameAndLease: boolean;
  readonly replacementFramePublishedAndRetiredOldLease: boolean;
  readonly runtimeUploadsExactlyOnce: boolean;
  readonly resourcesReleased: boolean;
  readonly gpuErrorScopesClean: boolean;
  readonly deviceDiagnosticsClean: boolean;
  readonly nonFallbackAdapter: boolean;
  readonly pixels: Readonly<{ legacy: Rgba | null; firstStage: Rgba | null;
    firstResident: Rgba | null; replacementStage: Rgba | null; replacement: Rgba | null }>;
  readonly uploads: Readonly<{ first: UploadCounts; replacement: UploadCounts }>;
  readonly resources: Readonly<{ baseline: number; replacementStage: number;
    replacementFrame: number; afterCleanup: number }>;
  readonly gpuErrors: readonly string[];
  readonly failure?: string;
}

type ProbeChecks = Omit<PbrResidentPacketFrameProbeResult, "action" | "success" | "failure">;

export function evaluatePbrResidentPacketFrameProbe(result: ProbeChecks): boolean {
  return result.firstStagePreservedOldFrame && result.firstFramePublishedResidentPacket
    && result.replacementStagePreservedOldFrameAndLease
    && result.replacementFramePublishedAndRetiredOldLease
    && result.runtimeUploadsExactlyOnce && result.resourcesReleased
    && result.gpuErrorScopesClean && result.deviceDiagnosticsClean && result.nonFallbackAdapter;
}

/** Proves renderer-owned resident packet publication on one real HTML canvas. */
export async function verifyPbrResidentPacketFrameBoundary(
  renderer: PbrRenderer,
  canvas: HTMLCanvasElement,
): Promise<PbrResidentPacketFrameProbeResult> {
  const session = renderer.session;
  if (session.state !== "ready") throw new Error("PBR resident packet probe requires a ready renderer.");
  const diagnosticsBefore = session.diagnostics.length, gpuErrors: string[] = [];
  const legacy = packet("legacy", [255, 0, 0], false), firstPacket = packet("first", [0, 255, 0], true);
  const replacementPacket = packet("replacement", [0, 0, 255], true), probeView = view(canvas);
  let first: LoadedResident | undefined, replacement: LoadedResident | undefined;
  let baseline = -1, replacementStageResources = -1, replacementFrameResources = -1;
  let legacyPixel: Rgba | null = null, firstStagePixel: Rgba | null = null;
  let firstPixel: Rgba | null = null, replacementStagePixel: Rgba | null = null;
  let replacementPixel: Rgba | null = null, failure: string | undefined, restored = false;
  let firstStagePreservedOldFrame = false, firstFramePublishedResidentPacket = false;
  let replacementStagePreservedOldFrameAndLease = false;
  let replacementFramePublishedAndRetiredOldLease = false;

  for (const filter of ["validation", "out-of-memory", "internal"] as const) {
    session.device.pushErrorScope(filter);
  }
  try {
    await renderer.setPacketValidated(legacy);
    session.context.configure({ device: session.device, format: session.format, alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    requireFrame(renderer.render(probeView));
    baseline = session.resourceCount;

    first = await loadResident(session, prepareRenderPacket(firstPacket), 10_001);
    replacement = await loadResident(session, prepareRenderPacket(replacementPacket), 10_002);
    requireFrame(renderer.render(probeView));
    const legacyRead = surfacePixel(session, canvas);
    const firstStage = renderer.stageResidentPacketValidated(first.projection);
    const firstStageRead = surfacePixel(session, canvas);
    [legacyPixel, firstStagePixel] = await Promise.all([legacyRead, firstStageRead]);
    await firstStage;
    firstStagePreservedOldFrame = samePixel(legacyPixel, firstStagePixel)
      && dominant(legacyPixel, 0) && !first.projection.released;

    requireFrame(renderer.render(probeView));
    const firstRead = surfacePixel(session, canvas);
    first.runtime.dispose();
    const firstLeaseHeldAfterRuntimeDispose = first.runtime.retiredBytes > 0 && !first.projection.released;
    const replacementStage = renderer.stageResidentPacketValidated(replacement.projection);
    const replacementStageRead = surfacePixel(session, canvas);
    [firstPixel, replacementStagePixel] = await Promise.all([firstRead, replacementStageRead]);
    await replacementStage;
    firstFramePublishedResidentPacket = dominant(firstPixel, 1)
      && changed(legacyPixel, firstPixel) && !first.projection.released;
    replacementStageResources = session.resourceCount;
    replacementStagePreservedOldFrameAndLease = samePixel(firstPixel, replacementStagePixel)
      && dominant(replacementStagePixel, 1) && firstLeaseHeldAfterRuntimeDispose
      && !first.projection.released && !replacement.projection.released;

    requireFrame(renderer.render(probeView));
    replacementFrameResources = session.resourceCount;
    replacementPixel = await surfacePixel(session, canvas);
    replacementFramePublishedAndRetiredOldLease = dominant(replacementPixel, 2)
      && changed(firstPixel, replacementPixel) && first.projection.released
      && first.runtime.retiredBytes === 0 && !replacement.projection.released
      && replacementFrameResources < replacementStageResources;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await renderer.setPacketValidated(legacy);
      await renderer.validateFrame(probeView);
      restored = true;
    } catch (error) {
      failure ??= `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    first?.runtime.dispose(); replacement?.runtime.dispose();
    for (let index = 0; index < 3; index++) {
      try {
        const error = await session.device.popErrorScope();
        if (error) gpuErrors.push(error.message);
      } catch (error) { gpuErrors.push(error instanceof Error ? error.message : String(error)); }
    }
  }

  const afterCleanup = session.resourceCount;
  const firstUploads = first?.uploads ?? Object.freeze({ geometry: 0, texture: 0 });
  const replacementUploads = replacement?.uploads ?? Object.freeze({ geometry: 0, texture: 0 });
  const runtimeUploadsExactlyOnce = exactlyOnce(firstUploads) && exactlyOnce(replacementUploads)
    && first?.appliedUploads === 2 && replacement?.appliedUploads === 2
    && first.gpuResourceDelta === 3 && replacement.gpuResourceDelta === 3;
  const values: ProbeChecks = Object.freeze({ firstStagePreservedOldFrame,
    firstFramePublishedResidentPacket, replacementStagePreservedOldFrameAndLease,
    replacementFramePublishedAndRetiredOldLease, runtimeUploadsExactlyOnce,
    resourcesReleased: restored && baseline >= 0 && afterCleanup === baseline,
    gpuErrorScopesClean: gpuErrors.length === 0,
    deviceDiagnosticsClean: session.diagnostics.length === diagnosticsBefore,
    nonFallbackAdapter: session.adapterInfo?.isFallbackAdapter === false,
    pixels: Object.freeze({ legacy: legacyPixel, firstStage: firstStagePixel,
      firstResident: firstPixel, replacementStage: replacementStagePixel, replacement: replacementPixel }),
    uploads: Object.freeze({ first: firstUploads, replacement: replacementUploads }),
    resources: Object.freeze({ baseline, replacementStage: replacementStageResources,
      replacementFrame: replacementFrameResources, afterCleanup }),
    gpuErrors: Object.freeze(gpuErrors) });
  const success = failure === undefined && evaluatePbrResidentPacketFrameProbe(values);
  return Object.freeze({ action: "pbr-resident-packet-frame-boundary", success, ...values,
    ...(failure ? { failure } : {}) });
}

interface LoadedResident {
  readonly runtime: GpuRenderResidencyRuntime;
  readonly projection: ResidentPacketProjection;
  readonly uploads: UploadCounts;
  readonly appliedUploads: number;
  readonly gpuResourceDelta: number;
}

async function loadResident(session: DeviceSession, prepared: ReturnType<typeof prepareRenderPacket>,
  frame: number): Promise<LoadedResident> {
  const loader = createPacketResidencyLoader(prepared), resourcesBefore = session.resourceCount;
  const runtime = loader.createRuntime(session,
    { maxResidentBytes: 64 * 1024 * 1024, maxUploadBytesPerFrame: 64 * 1024 * 1024 },
    { maxConcurrentUploads: 2 });
  try {
    const projection = await loader.loadInto(runtime, { frame });
    const residents = runtime.snapshot();
    const counts = { geometry: residents.filter(value => value.kind === "geometry").length,
      texture: residents.filter(value => value.kind === "texture").length };
    return { runtime, projection, uploads: Object.freeze(counts), appliedUploads: residents.length,
      gpuResourceDelta: session.resourceCount - resourcesBefore };
  } catch (error) { runtime.dispose(); throw error; }
}

function packet(id: string, color: readonly [number, number, number], textured: boolean): RenderPacket {
  const mesh = sphereMesh(16, 10), geometry: GeometryResource = { id: `${id}-geometry`, revision: 1,
    ...mesh, uv0: new Float32Array(mesh.vertices.length / 3).fill(0.5) };
  const texture: DecodedTexture | undefined = textured ? { id: `${id}-emissive`, revision: 1,
    semantic: "emissive", width: 1, height: 1, data: new Uint8Array([...color, 255]),
    sampler: { magFilter: "nearest", minFilter: "nearest", mipmapFilter: "nearest" } } : undefined;
  return { geometries: [geometry], ...(texture ? { textures: [texture] } : {}),
    materials: [{ id: `${id}-material`, baseColor: [0, 0, 0], metallic: 0, roughness: 1,
      emissiveFactor: textured ? [1, 1, 1] : color.map(value => value / 255) as [number, number, number],
      emissiveStrength: 8, ...(texture ? { emissiveTexture: { texture: texture.id } } : {}) }],
    instances: [{ id: `${id}-instance`, geometry: geometry.id, material: `${id}-material`,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.8, 0, 1] }] };
}

function view(canvas: HTMLCanvasElement): RenderView {
  return { width: canvas.clientWidth, height: canvas.clientHeight, pixelRatio: devicePixelRatio,
    eye: [0, 0.8, 3.4], target: [0, 0.8, 0], up: [0, 1, 0], extent: 2,
    background: [0.002, 0.002, 0.002], floor: [0.003, 0.003, 0.003], exposure: 1, roughness: 1 };
}

async function surfacePixel(session: DeviceSession, canvas: HTMLCanvasElement): Promise<Rgba> {
  const buffer = session.device.createBuffer({ label: "Deep resident packet surface readback", size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = session.device.createCommandEncoder({ label: "Deep resident packet surface copy" });
    encoder.copyTextureToBuffer({ texture: session.context.getCurrentTexture(),
      origin: [Math.max(0, Math.floor(canvas.width / 2)), Math.max(0, Math.floor(canvas.height / 2))] },
    { buffer, bytesPerRow: 256 }, [1, 1]);
    session.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = Array.from(new Uint8Array(buffer.getMappedRange(), 0, 4));
    buffer.unmap();
    const rgba = session.format.startsWith("bgra")
      ? [bytes[2]!, bytes[1]!, bytes[0]!, bytes[3]!] : bytes;
    return Object.freeze(rgba as [number, number, number, number]);
  } finally { buffer.destroy(); }
}

function dominant(pixel: Rgba | null, channel: 0 | 1 | 2): boolean {
  if (!pixel) return false;
  const others = [0, 1, 2].filter(value => value !== channel).map(value => pixel[value]!);
  return pixel[channel] >= 96 && pixel[channel] - Math.max(...others) >= 32;
}
function samePixel(left: Rgba | null, right: Rgba | null): boolean {
  return !!left && !!right && left.every((value, index) => Math.abs(value - right[index]!) <= 2);
}
function changed(left: Rgba | null, right: Rgba | null): boolean {
  return !!left && !!right && left.slice(0, 3).reduce((sum, value, index) => sum + Math.abs(value - right[index]!), 0) >= 96;
}
const exactlyOnce = (counts: UploadCounts): boolean => counts.geometry === 1 && counts.texture === 1;
function requireFrame(frame: unknown): void {
  if (!frame) throw new Error("PBR resident packet probe could not encode a surface frame.");
}
