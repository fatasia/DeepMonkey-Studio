import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { PbrTransientTexturePool } from "../src/webgpu/pbrTransientTexturePool.js";
import { AuthorBloomPass } from "../src/postprocess/authorBloom.js";
import { decodeFloat16Bits, encodeFloat16Bits } from "./temporalAaProbe.js";
import { authorBloomReference } from "./authorBloomReference.js";

/** Real adapter dispatch/readback; CPU reference includes each rgba16float intermediate store. */
export async function runAuthorBloomGpuProbe() {
  const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
  document.body.append(canvas);
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const pool = new PbrTransientTexturePool(session), pass = new AuthorBloomPass(session, pool), device = session.device;
  const cases = [
    { name: "strength-zero-odd", width: 17, height: 9, strength: 0, threshold: 0.9, pattern: "spot" },
    { name: "threshold-below", width: 16, height: 8, strength: 0.35, threshold: 0.9, pattern: "below" },
    { name: "threshold-transition", width: 16, height: 8, strength: 0.35, threshold: 0.9, pattern: "transition" },
    { name: "five-mip-odd-spot", width: 65, height: 33, strength: 0.35, threshold: 0.9, pattern: "spot" },
    { name: "hot-parameters", width: 65, height: 33, strength: 1.5, threshold: 0.1, pattern: "spot" },
    { name: "one-pixel", width: 1, height: 1, strength: 3, threshold: 0, pattern: "hdr" },
  ];
  const observations = [];
  try {
    let revision = 0;
    for (const item of cases) {
      const { width, height } = item, rowBytes = Math.ceil(width * 8 / 256) * 256;
      const bytes = new ArrayBuffer(rowBytes * height), upload = new DataView(bytes), pixels = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const hot = Math.abs(x - Math.floor(width / 2)) < 3 && Math.abs(y - Math.floor(height / 2)) < 3;
        const color = item.pattern === "below" ? [0.5, 0.5, 0.5, 1] : item.pattern === "transition" ? [0.905, 0.905, 0.905, 1]
          : item.pattern === "hdr" || hot ? [3, 1.5, 0.25, 1] : [0.125, 0.25, 0.5, 1];
        for (let c = 0; c < 4; c++) {
          const bits = encodeFloat16Bits(color[c]!); upload.setUint16(y * rowBytes + x * 8 + c * 2, bits, true);
          pixels[(y * width + x) * 4 + c] = decodeFloat16Bits(bits);
        }
      }
      const color = device.createTexture({ size: [width, height], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      const readback = device.createBuffer({ size: rowBytes * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      device.pushErrorScope("validation");
      try {
        device.queue.writeTexture({ texture: color }, bytes, { bytesPerRow: rowBytes }, [width, height]);
        pool.beginFrame();
        const encoder = device.createCommandEncoder(), result = pass.encode(encoder, { color, revision: revision++, colorEncoding: "linear-hdr" },
          { strength: item.strength, threshold: item.threshold });
        encoder.copyTextureToBuffer({ texture: result.texture }, { buffer: readback, bytesPerRow: rowBytes }, [width, height]);
        device.queue.submit([encoder.finish()]); pool.endFrame(true); await device.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        const actual = new DataView(readback.getMappedRange()), expected = authorBloomReference({ width, height, pixels }, item.strength, item.threshold);
        let maxAbsoluteError = 0, maxRelativeError = 0, mismatches = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
          const observed = decodeFloat16Bits(actual.getUint16(y * rowBytes + x * 8 + c * 2, true)), reference = expected.pixels[(y * width + x) * 4 + c]!;
          const delta = Math.abs(observed - reference), relative = delta / Math.max(0.01, Math.abs(reference));
          maxAbsoluteError = Math.max(maxAbsoluteError, delta); maxRelativeError = Math.max(maxRelativeError, relative);
          if (!Number.isFinite(observed) || delta > 0.003 + Math.abs(reference) * 0.004) mismatches++;
        }
        observations.push({ name: item.name, width, height, strength: item.strength, threshold: item.threshold,
          maxAbsoluteError, maxRelativeError, mismatches, passCount: result.passCount });
      } finally {
        if (pool.frameOpen) pool.endFrame(false);
        if (readback.mapState === "mapped") readback.unmap(); readback.destroy(); color.destroy();
        const error = await device.popErrorScope(); if (error) throw new Error(error.message);
      }
    }
    const transientTextures = pool.stats; pass.dispose(); pool.dispose();
    return { success: observations.every(item => item.mismatches === 0) && !session.hasErrors && session.resourceCount === 0,
      adapter: session.adapterInfo, tolerance: "abs <= 0.003 + abs(reference) * 0.004", observations,
      transientTextures, diagnostics: session.diagnostics, resourcesAfterDispose: session.resourceCount };
  } finally { pass.dispose(); pool.dispose(); session.dispose(); canvas.remove(); }
}
