import { createHash } from "node:crypto";
import { compareGeometryDepth } from "./j3GeometryDepthParity.mjs";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const close = (a, b) => Math.abs(a - b) <= 1e-6;

function metrics(a, b, peak) {
  let max = 0, squared = 0, absolute = 0;
  for (let i = 0; i < a.length; i++) {
    const error = Math.abs(a[i] - b[i]); max = Math.max(max, error); squared += error * error; absolute += error;
  }
  const mse = squared / a.length, ssims = [];
  for (let channel = 0; channel < 3; channel++) {
    const x = a.filter((_, i) => i % 3 === channel), y = b.filter((_, i) => i % 3 === channel);
    const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
    let vx = 0, vy = 0, cov = 0;
    for (let i = 0; i < x.length; i++) { vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; cov += (x[i] - mx) * (y[i] - my); }
    const n = Math.max(1, x.length - 1), c1 = (.01 * peak) ** 2, c2 = (.03 * peak) ** 2;
    ssims.push((2 * mx * my + c1) * (2 * cov / n + c2) / ((mx * mx + my * my + c1) * (vx / n + vy / n + c2)));
  }
  return { maxError: max, meanError: absolute / a.length, psnr: mse === 0 ? null : 10 * Math.log10(peak * peak / mse),
    exact: mse === 0, ssim: Math.min(...ssims) };
}

function validLighting(frame, manifest, native) {
  const actual = frame.lighting, sun = manifest.sun;
  if (!actual || actual.direction?.length !== 3 || actual.radiance?.length !== 3
    || !actual.direction.every((value, i) => close(value, sun.surfaceToLightWorld[i]))
    || !actual.radiance.every((value, i) => close(value, sun.radiance[i]))
    || !close(actual.exposure, sun.exposure) || actual.environment !== 0 || actual.shadows !== 0
    || (native ? actual.authoredMode !== 2 || actual.localLights !== 0
      : actual.intensity !== sun.intensity || frame.localLightCount !== 0
        || actual.diffuseCoefficients?.length !== 16 || !actual.diffuseCoefficients.every(value => value === 0)))
    throw Error("Actual common lighting uniforms differ from preregistered sun");
}

export function compareHdrFlat(manifest, web, native) {
  const geometry = compareGeometryDepth(manifest, web, native), { hdrThresholds: t, width, height } = manifest;
  const cases = [], diagnostics = [];
  for (const [host, isNative] of [[web, false], [native, true]]) {
    if (!/^[a-f0-9]{64}$/.test(host.sourceHash ?? "")) throw Error("Missing actual production shader source identity");
    if (host.profile !== "same-authored-sun" || host.defaults?.length !== manifest.cameras.length) throw Error("Missing one-shot default/profile evidence");
    for (const frame of host.frames) {
      if (frame.hdr?.length !== width * height * 3 || !frame.hdr.every(Number.isFinite)) throw Error("Invalid actual HDR layout/values");
      validLighting(frame, manifest, isNative);
    }
    for (const camera of manifest.cameras) {
      const a = host.frames.filter(frame => frame.cameraId === camera.id);
      if (hash(a[0].hdr) !== hash(a[1].hdr) || hash(a[0].lighting) !== hash(a[1].lighting)) throw Error("Repeated actual HDR/lighting drift");
    }
  }
  for (const camera of manifest.cameras) {
    const wf = web.frames.filter(f => f.cameraId === camera.id), nf = native.frames.filter(f => f.cameraId === camera.id);
    for (const subset of camera.subsets) {
      if (subset.pixels.length < t.minPixelsPerSubset || new Set(subset.pixels).size !== subset.pixels.length) throw Error("Invalid preregistered triangle mask");
      const rounds = wf.map((w, round) => {
        const n = nf[round], a = [], b = [];
        if (subset.diffuseFloor?.length !== 3 || !subset.diffuseFloor.every(value => Number.isFinite(value) && value > 0))
          throw Error("Missing positive CPU Lambert lower bound for strict triangle material");
        for (const pixel of subset.pixels) {
          if (!Number.isInteger(pixel) || pixel < 0 || pixel >= width * height || w.depth[pixel] >= 1 - 1e-7
            || n.depth.slice(pixel * 4, pixel * 4 + 4).some(value => value >= 1 - 1e-7)) throw Error("Missing actual geometry in frozen HDR mask");
          a.push(...w.hdr.slice(pixel * 3, pixel * 3 + 3)); b.push(...n.hdr.slice(pixel * 3, pixel * 3 + 3));
          for (const host of [w, n]) for (let lane = 0; lane < 3; lane++) {
            const floor = subset.diffuseFloor[lane], halfQuantization = Math.max(floor / 1024, 1e-6);
            if (host.hdr[pixel * 3 + lane] < floor - halfQuantization) throw Error("Actual HDR below independent CPU direct-Lambert bound");
          }
        }
        const result = metrics(a, b, t.peak);
        if (result.maxError > t.maxChannelError || (!result.exact && result.psnr < t.minPsnr) || result.ssim < t.minSsim)
          throw Error(`Strict flat-normal HDR drift ${camera.id}/${subset.instanceId}: ${JSON.stringify(result)}`);
        return result;
      });
      cases.push({ cameraId: camera.id, instanceId: subset.instanceId, pixels: subset.pixels.length, rounds });
    }
    const commonPixels = Array.from({ length: width * height }, (_, pixel) => pixel).filter(pixel =>
      wf[0].depth[pixel] < 1 - 1e-7 && nf[0].depth.slice(pixel * 4, pixel * 4 + 4).every(value => value < 1 - 1e-7));
    const sample = (frame, pixels) => pixels.flatMap(pixel => frame.hdr.slice(pixel * 3, pixel * 3 + 3));
    const wd = web.defaults.find(f => f.cameraId === camera.id), nd = native.defaults.find(f => f.cameraId === camera.id);
    if (wd?.hdr?.length !== width * height * 3 || nd?.hdr?.length !== width * height * 3
      || !wd.hdr.every(Number.isFinite) || !nd.hdr.every(Number.isFinite)) throw Error("Missing actual default HDR diagnostic");
    diagnostics.push({ cameraId: camera.id, pixels: commonPixels.length,
      common: metrics(sample(wf[0], commonPixels), sample(nf[0], commonPixels), t.peak),
      default: metrics(sample(wd, commonPixels), sample(nd, commonPixels), t.peak) });
  }
  return { passed: true, packageHash: manifest.packageHash, packetHash: manifest.packetHash, geometry, cases, diagnostics,
    scope: "production-HDR-authored-single-sun-flat-normal-triangles",
    legalDifferences: ["Native4xMSAA/Web1x edges", "smooth cube Web derivative roughness; diagnostic only"],
    excluded: ["production normal MRT parity", "IBL/GI/shadow/full material family", "full Gate D"] };
}
