/// <reference types="@webgpu/types" />
import type { GpuResidencyUploadRequest } from "@bim-studio/deep-engine/streaming";
import {
  createPacketResidencyCatalog,
  GpuRenderResidencyRuntime,
  type DeviceSession,
  type GpuRenderResidencyFrameResult,
  type GpuTextureResidencyHandle,
  type PacketResidencyCatalog,
} from "@bim-studio/deep-engine/webgpu";
import {
  BC1_EXPECTED,
  BC1_TEXTURE_ID,
  bc1MipPacket,
  RGBA_EXPECTED,
  RGBA_TEXTURE_ID,
  rgbaMipPacket,
} from "./gpuTextureMipResidencyFixtures.js";
import { sampledColor, sampleTextureMip } from "./gpuTextureMipSample.js";

export type BcMipResidencyStatus = "passed" | "skipped" | "failed";

export interface GpuTextureMipResidencyProbeResult {
  readonly action: "gpu-texture-mip-residency";
  readonly success: boolean;
  readonly rgbaCatalogLevelsExact: boolean;
  readonly rgbaLevel1Sampled: boolean;
  readonly rgbaLevel2Sampled: boolean;
  readonly bcCatalogBlockedIllegalBase: boolean;
  readonly bcStatus: BcMipResidencyStatus;
  readonly bcTailMipSampled: boolean;
  readonly gpuErrorScopesClean: boolean;
  readonly deviceDiagnosticsClean: boolean;
  readonly resourcesReleased: boolean;
  readonly nonFallbackAdapter: boolean;
  readonly rgbaPixels: Readonly<Record<"1" | "2", readonly number[] | null>>;
  readonly bcPixels: readonly (readonly number[])[];
  readonly gpuErrors: readonly string[];
  readonly failure?: string;
}

type ProbeChecks = Omit<GpuTextureMipResidencyProbeResult, "action" | "success" | "failure">;

export function evaluateGpuTextureMipResidencyProbe(result: ProbeChecks): boolean {
  const bcPassed = result.bcStatus === "skipped"
    || (result.bcStatus === "passed" && result.bcTailMipSampled);
  return result.rgbaCatalogLevelsExact && result.rgbaLevel1Sampled && result.rgbaLevel2Sampled
    && result.bcCatalogBlockedIllegalBase && bcPassed && result.gpuErrorScopesClean
    && result.deviceDiagnosticsClean && result.resourcesReleased && result.nonFallbackAdapter;
}

/** Proves packet-catalog mip suffixes are independently uploaded and sampled on the current GPU. */
export async function verifyGpuTextureMipResidency(
  session: DeviceSession,
): Promise<GpuTextureMipResidencyProbeResult> {
  if (session.state !== "ready") throw new Error("Texture mip residency probe requires a ready device session.");
  const resourcesBefore = session.resourceCount, diagnosticsBefore = session.diagnostics.length;
  const errors: string[] = [];
  let rgbaPixels: ProbeChecks["rgbaPixels"] = Object.freeze({ 1: null, 2: null });
  let bcPixels: readonly (readonly number[])[] = Object.freeze([]);
  let rgbaCatalogLevelsExact = false, rgbaLevel1Sampled = false, rgbaLevel2Sampled = false;
  let bcCatalogBlockedIllegalBase = false, bcTailMipSampled = false;
  let bcStatus: BcMipResidencyStatus = session.device.features.has("texture-compression-bc")
    ? "failed" : "skipped";
  try {
    const rgba = createPacketResidencyCatalog(rgbaMipPacket());
    rgbaCatalogLevelsExact = profileLevels(rgba, RGBA_TEXTURE_ID) === "0:84,1:20,2:4";
    const rgbaResult = await sampleRgbaSuffixes(session, rgba);
    rgbaPixels = rgbaResult.pixels; errors.push(...rgbaResult.errors);
    rgbaLevel1Sampled = rgbaResult.level1; rgbaLevel2Sampled = rgbaResult.level2;

    const bc = createPacketResidencyCatalog(bc1MipPacket());
    bcCatalogBlockedIllegalBase = profileLevels(bc, BC1_TEXTURE_ID) === "0:56,1:24"
      && rejectsIllegalCompressedBase(bc);
    if (bcStatus !== "skipped") {
      const bcResult = await sampleBcTail(session, bc);
      bcPixels = bcResult.pixels; errors.push(...bcResult.errors);
      bcTailMipSampled = bcResult.sampled; bcStatus = bcTailMipSampled ? "passed" : "failed";
    }
    const values: ProbeChecks = Object.freeze({ rgbaCatalogLevelsExact, rgbaLevel1Sampled, rgbaLevel2Sampled,
      bcCatalogBlockedIllegalBase, bcStatus, bcTailMipSampled, gpuErrorScopesClean: errors.length === 0,
      deviceDiagnosticsClean: session.diagnostics.length === diagnosticsBefore,
      resourcesReleased: session.resourceCount === resourcesBefore,
      nonFallbackAdapter: session.adapterInfo?.isFallbackAdapter === false,
      rgbaPixels, bcPixels, gpuErrors: Object.freeze(errors) });
    return Object.freeze({ action: "gpu-texture-mip-residency",
      success: evaluateGpuTextureMipResidencyProbe(values), ...values });
  } catch (error) {
    return Object.freeze({ action: "gpu-texture-mip-residency", success: false,
      rgbaCatalogLevelsExact, rgbaLevel1Sampled, rgbaLevel2Sampled, bcCatalogBlockedIllegalBase,
      bcStatus, bcTailMipSampled, gpuErrorScopesClean: errors.length === 0,
      deviceDiagnosticsClean: session.diagnostics.length === diagnosticsBefore,
      resourcesReleased: session.resourceCount === resourcesBefore,
      nonFallbackAdapter: session.adapterInfo?.isFallbackAdapter === false,
      rgbaPixels, bcPixels, gpuErrors: Object.freeze(errors),
      failure: error instanceof Error ? error.message : String(error) });
  }
}

async function sampleRgbaSuffixes(session: DeviceSession, catalog: PacketResidencyCatalog) {
  const runtime = runtimeFor(session, catalog, 84);
  try {
    const level1 = await publishAndSample(runtime, session.device, RGBA_TEXTURE_ID, 1, [0]);
    const level2 = await publishAndSample(runtime, session.device, RGBA_TEXTURE_ID, 2, [0]);
    return Object.freeze({
      level1: level1.shape === "2x2x2" && sampledColor(level1.pixels[0]!, RGBA_EXPECTED[1]),
      level2: level2.shape === "1x1x1" && sampledColor(level2.pixels[0]!, RGBA_EXPECTED[2]),
      pixels: Object.freeze({ 1: level1.pixels[0] ?? null, 2: level2.pixels[0] ?? null }),
      errors: Object.freeze([...level1.errors, ...level2.errors]),
    });
  } finally { runtime.dispose(); }
}

async function sampleBcTail(session: DeviceSession, catalog: PacketResidencyCatalog) {
  const runtime = runtimeFor(session, catalog, 56);
  try {
    const result = await publishAndSample(runtime, session.device, BC1_TEXTURE_ID, 1, [0, 1, 2]);
    return Object.freeze({ sampled: result.shape === "4x4x3"
      && result.pixels.every((pixel, index) => sampledColor(pixel, BC1_EXPECTED[index]!)),
    pixels: result.pixels, errors: result.errors });
  } finally { runtime.dispose(); }
}

function runtimeFor(session: DeviceSession, catalog: PacketResidencyCatalog,
  bytes: number): GpuRenderResidencyRuntime {
  const runtime = new GpuRenderResidencyRuntime(session,
    { maxResidentBytes: bytes, maxUploadBytesPerFrame: bytes }, catalog.sourceFor);
  catalog.registerInto(runtime); return runtime;
}

async function publishAndSample(runtime: GpuRenderResidencyRuntime, device: GPUDevice,
  id: string, level: number, mips: readonly number[]) {
  const frame = await runtime.submit(level + 1, [{ id, kind: "texture", desiredLevel: level, required: true }]);
  requireApplied(frame, id);
  const state = runtime.get("texture", id), lease = runtime.acquire("texture", id);
  if (!state || state.level !== level || !lease || lease.resource.kind !== "texture") {
    lease?.release(); throw new Error(`Texture residency level was not published: ${id}:${level}.`);
  }
  const texture: GpuTextureResidencyHandle = lease.resource;
  try {
    const samples = [];
    for (const mip of mips) samples.push(await sampleTextureMip(device, texture, mip));
    return Object.freeze({ shape: `${texture.width}x${texture.height}x${texture.mipLevelCount}`,
      pixels: Object.freeze(samples.map(sample => sample.rgba)),
      errors: Object.freeze(samples.flatMap(sample => sample.errors)) });
  } finally { lease.release(); }
}

function requireApplied(frame: GpuRenderResidencyFrameResult, id: string): void {
  const failures = frame.execution?.uploadFailures ?? [];
  if (frame.status !== "applied" || !frame.execution || failures.length
    || !frame.execution.commit.appliedUploads.some(resource => resource.kind === "texture" && resource.id === id)) {
    const reason = failures[0]?.reason;
    throw new Error(`Texture residency upload was not applied: ${id}${reason ? `: ${String(reason)}` : "."}`);
  }
}

function profileLevels(catalog: PacketResidencyCatalog, id: string): string {
  return catalog.profiles.find(profile => profile.kind === "texture" && profile.id === id)?.levels
    .map(level => `${level.level}:${level.byteLength}`).join(",") ?? "";
}

function rejectsIllegalCompressedBase(catalog: PacketResidencyCatalog): boolean {
  const request = { id: BC1_TEXTURE_ID, kind: "texture", revision: 1, level: 2,
    expectedByteLength: 16, signal: new AbortController().signal } satisfies GpuResidencyUploadRequest;
  try { catalog.sourceFor(request); return false; }
  catch (error) { return error instanceof Error && error.message.includes("Unknown texture residency level"); }
}
