import type { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { RuntimePrefilteredIbl } from "../src/runtimePackage/environmentTypes.js";
import type { PbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { floatToHalf } from "./iblReferenceEncode.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";

export interface KeptMipsProductionResult {
  finite: boolean; keptMips: number; sharpClampError: number; roughPreservationError: number;
  sharpSignal: number; fullTextureBytes: number; tailTextureBytes: number;
  expectedSavedBytes: number; actualSavedBytes: number; hdrTailError: number;
}

function constantPlane(size: number, radiance: number): string {
  const bytes = new Uint8Array(size * size * 6 * 8), words = new DataView(bytes.buffer);
  for (let pixel = 0; pixel < size * size * 6; pixel++) {
    for (let c = 0; c < 3; c++) words.setUint16(pixel * 8 + c * 2, floatToHalf(radiance), true);
    words.setUint16(pixel * 8 + 6, floatToHalf(1), true);
  }
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 4096) encoded += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(encoded);
}
function rgb(frame: PbrFrameReadbackSnapshot): number[] {
  const data = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength), result: number[] = [];
  for (let y = 0; y < frame.height; y += 2) for (let x = 0; x < frame.width; x += 2) for (let c = 0; c < 3; c++) {
    result.push(decodeHalfFloat(data.getUint16(y * frame.bytesPerRow + x * 8 + c * 2, true)));
  }
  return result;
}
function difference(a: PbrFrameReadbackSnapshot, b: PbrFrameReadbackSnapshot): number {
  const av = rgb(a), bv = rgb(b); let max = 0;
  for (let i = 0; i < av.length; i++) max = Math.max(max, Math.abs(av[i]! - bv[i]!));
  return max;
}

/** Per-mip radiance fingerprints make an incorrect roughness remap observable. */
export async function probeKeptMipsProduction(renderer: PbrRenderer, source: RuntimePrefilteredIbl,
  frame: () => Promise<PbrFrameReadbackSnapshot>, material: (roughness: number) => void,
  hdrSource: Parameters<PbrRenderer["stageEnvironment"]>[0]): Promise<KeptMipsProductionResult> {
  const keptMips = 3, dropped = source.specular.mips.length - keptMips;
  const tagged = { ...source, specular: { ...source.specular,
    mips: source.specular.mips.map((mip, level) => ({ ...mip, dataBase64: constantPlane(mip.size, .125 + level / 8) })) } };
  const firstRetained = .125 + dropped / 8;
  const sharpExpected = { ...tagged, specular: { ...tagged.specular,
    mips: tagged.specular.mips.map(mip => ({ ...mip, dataBase64: constantPlane(mip.size, firstRetained) })) } };
  material(.12);
  await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: sharpExpected });
  const expected = await frame();
  await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: tagged });
  const sharpFull = await frame(), fullTextureBytes = renderer.session.resourceMemory.textureBytes;
  await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: tagged, keptMips });
  const sharpTail = await frame(), tailTextureBytes = renderer.session.resourceMemory.textureBytes;
  const sharpClampError = difference(expected, sharpTail), sharpSignal = difference(sharpFull, sharpTail);
  let roughPreservationError = 0;
  for (const roughness of [.8, 1]) {
    material(roughness);
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: tagged });
    const full = await frame();
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: tagged, keptMips });
    const tail = await frame();
    roughPreservationError = Math.max(roughPreservationError, difference(full, tail));
  }
  // Actual GPU prefilter must retain original roughness settings too.
  material(1);
  await renderer.stageEnvironment(hdrSource);
  const hdrFull = await frame();
  await renderer.stageEnvironment({ ...hdrSource, keptMips });
  const hdrTail = await frame();
  const expectedSavedBytes = source.specular.mips.slice(0, dropped).reduce((bytes, mip) => bytes + mip.size * mip.size * 6 * 8, 0);
  material(.12);
  return { finite: rgb(sharpTail).every(Number.isFinite), keptMips, sharpClampError, roughPreservationError,
    sharpSignal, fullTextureBytes, tailTextureBytes, expectedSavedBytes,
    actualSavedBytes: fullTextureBytes - tailTextureBytes, hdrTailError: difference(hdrFull, hdrTail) };
}
