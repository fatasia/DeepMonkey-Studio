import { createHash } from "node:crypto";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const covered = value => value < 1 - 1e-7;

function edge(mask, pixel, width, height) {
  const x = pixel % width, y = Math.floor(pixel / width);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx] !== mask[pixel]) return true;
  }
  return false;
}

function compareFrame(manifest, camera, web, native) {
  const { width, height, thresholds: t } = manifest, pixels = width * height;
  if (web.depthSamples !== 1 || native.depthSamples !== 4 || web.depth.length !== pixels || native.depth.length !== pixels * 4)
    throw Error("Unexpected production depth layout or MSAA profile");
  if ([...web.depth, ...native.depth].some(value => !Number.isFinite(value) || value < 0 || value > 1))
    throw Error("Invalid hardware depth values");
  if (web.vp.length !== 16 || native.vp.length !== 16 || ![...web.vp, ...native.vp].every(Number.isFinite)) throw Error("Invalid uploaded VP");
  const vpMaxError = web.vp.reduce((max, value, index) => Math.max(max, Math.abs(value - native.vp[index])), 0);
  if (vpMaxError > t.vpMaxError) throw Error("Actual uploaded camera VP drift");
  if (camera.expectedVP?.length !== 16 || !camera.expectedVP.every(Number.isFinite)) throw Error("Missing preregistered expected camera VP");
  const referenceError = Math.max(...[web, native].map(frame => frame.vp.reduce((max, value, index) =>
    Math.max(max, Math.abs(value - camera.expectedVP[index])), 0)));
  if (referenceError > t.vpMaxError) throw Error("Actual uploaded camera VP differs from manifest reference");
  if (!(web.hdrNonBackground > 32 && native.hdrNonBackground > 32)) throw Error("Empty production HDR frame");
  const wm = web.depth.map(covered), nm = Array.from({ length: pixels }, (_, pixel) =>
    native.depth.slice(pixel * 4, pixel * 4 + 4).some(covered));
  if (wm.filter(Boolean).length < 64 || nm.filter(Boolean).length < 64) throw Error("Empty production geometry depth");
  let boundaryDifferences = 0, stablePixels = 0, maxDepthError = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    if (wm[pixel] !== nm[pixel]) {
      // A mismatch must touch BOTH actual silhouettes; a missing/shifted object cannot qualify itself by its own edge.
      if (!edge(wm, pixel, width, height) || !edge(nm, pixel, width, height)) throw Error("Geometry coverage drift beyond common 1px boundary");
      boundaryDifferences++;
    }
    const x = pixel % width, y = Math.floor(pixel / width), samples = native.depth.slice(pixel * 4, pixel * 4 + 4);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || !wm[pixel] || !samples.every(covered)) continue;
    let planar = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const neighbor = pixel + dy * width + dx;
      if (!wm[neighbor]) planar = false;
      const expected = web.depth[pixel] + dx * (web.depth[pixel + 1] - web.depth[pixel - 1]) / 2
        + dy * (web.depth[pixel + width] - web.depth[pixel - width]) / 2;
      if (Math.abs(web.depth[neighbor] - expected) > t.planeMaxError) planar = false;
    }
    if (!planar) continue;
    const mean = samples.reduce((sum, value) => sum + value, 0) / 4;
    maxDepthError = Math.max(maxDepthError, Math.abs(mean - web.depth[pixel])); stablePixels++;
  }
  if (stablePixels < t.minStablePixels) throw Error("Insufficient stable interior depth samples");
  if (maxDepthError > t.depthMaxError) throw Error("Production interior depth drift");
  return { vpMaxError, vpReferenceMaxError: referenceError, boundaryDifferences, stablePixels, maxDepthError,
    webCoveredPixels: wm.filter(Boolean).length, nativeCoveredPixels: nm.filter(Boolean).length };
}

export function compareGeometryDepth(manifest, web, native) {
  if (manifest.thresholds.edgeRadius !== 1) throw Error("Only preregistered 1px silhouette differences are supported");
  for (const leg of [web, native]) {
    if (!leg || leg.passed !== true || leg.packageHash !== manifest.packageHash || leg.packetHash !== manifest.packetHash
      || leg.width !== manifest.width || leg.height !== manifest.height || leg.frames?.length !== manifest.cameras.length * 2)
      throw Error("Missing real production frame/manifest evidence");
    for (const camera of manifest.cameras) {
      const frames = leg.frames.filter(frame => frame.cameraId === camera.id);
      if (frames.length !== 2 || frames[0].round !== 0 || frames[1].round !== 1
        || hash(frames[0].depth) !== hash(frames[1].depth) || hash(frames[0].vp) !== hash(frames[1].vp)
        || frames[0].hdrNonBackground !== frames[1].hdrNonBackground) throw Error("Repeated production frame drift");
    }
  }
  const cases = manifest.cameras.map(camera => {
    const a = web.frames.filter(frame => frame.cameraId === camera.id), b = native.frames.filter(frame => frame.cameraId === camera.id);
    return { cameraId: camera.id, rounds: a.map((frame, index) => compareFrame(manifest, camera, frame, b[index])) };
  });
  return { passed: true, packageHash: manifest.packageHash, packetHash: manifest.packetHash, cases,
    scope: "production-geometry-depth-interior", legalDifferences: ["Native 4xMSAA vs Web 1x; shared 1px silhouettes and depth creases"],
    excluded: ["HDR material/color equivalence", "CSM/normal/postprocessing", "transparent/LOD/deformation", "full Gate D"] };
}
