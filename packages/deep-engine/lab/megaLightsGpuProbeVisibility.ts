// megaLightsGpuProbe ⑥/⑦ 可见性腿(体量门拆分;条目逐字未改):
// ⑥ M2 胜者可见性射线(2026-10-05;traceTwoLevelOccluded 片段族真机闭环)——
//    单灯+遮挡盒,阴影区抑制 ≥98%/亮区不变(CPU f64 线段-盒 oracle)/哨兵零/帧时披露;
// ⑦ 生产供给 perf:M2 三趟(RIS 两趟 + 胜者遮挡 trace)@5000 灯 1080p。
import { megaLightsFromClustered, packMegaLights } from "../src/lighting/megaLights.js";
import { MegaLightsRuntime } from "../src/lighting/megaLightsRuntime.js";
import type { LightVector3, PointLight } from "../src/lighting/types.js";
import { buildTlas, traceTlasClosest, type TlasInstanceDescriptor } from "../src/rayTracing/tlas.js";
import type { RayBlasDescriptor } from "../src/rayTracing/rayBackendTypes.js";
import { packTlasScene } from "../src/rayTracing/tlasLayout.js";
import { PERF_HEIGHT, PERF_LIGHT_COUNT, PERF_WIDTH, buildPerfLights, buildPerfSurfaces,
  compilationMessages, readbackColor, requestDevice, runFrame, shimSession } from "./megaLightsGpuProbeShared.js";

/** 可见性腿小场景:视空间 == 世界(viewToWorld 恒等)。z=−3 朗伯墙 + 单点光 +
 * 轴对齐遮挡盒;期望阴影区由 CPU f64 线段-盒解析判交逐像素给出(精确 oracle)。 */
const VIS_WIDTH = 320, VIS_HEIGHT = 180;

function buildVisibilitySurfaces(width: number, height: number): Float32Array {
  const surfaces = new Float32Array(width * height * 3 * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3 * 4;
      surfaces[index] = (x / width - 0.5) * 3.2;
      surfaces[index + 1] = (0.5 - y / height) * 1.8;
      surfaces[index + 2] = -3;
      surfaces[index + 3] = 0; // metallic
      surfaces[index + 4] = 0; surfaces[index + 5] = 0; surfaces[index + 6] = 1;
      surfaces[index + 7] = 0.5; // roughness(法线恒 +z:空间门全过,mask 语义无混杂)
      surfaces[index + 8] = 0.8; surfaces[index + 9] = 0.78; surfaces[index + 10] = 0.75;
    }
  }
  return surfaces;
}

/** CPU f64 oracle:线段(灯→像素)与轴对齐盒求交(slab 法;命中 = 该像素被遮挡)。 */
function segmentHitsBox(origin: readonly number[], target: readonly number[],
  boxCenter: readonly number[], boxHalf: readonly number[]): boolean {
  const dir = [target[0]! - origin[0]!, target[1]! - origin[1]!, target[2]! - origin[2]!];
  let tMin = 0, tMax = 1;
  for (let axis = 0; axis < 3; axis++) {
    const o = origin[axis]! - boxCenter[axis]!;
    if (Math.abs(dir[axis]!) < 1e-12) {
      if (o < -boxHalf[axis]! || o > boxHalf[axis]!) return false;
      continue;
    }
    let near = (-boxHalf[axis]! - o) / dir[axis]!;
    let far = (boxHalf[axis]! - o) / dir[axis]!;
    if (near > far) { const swap = near; near = far; far = swap; }
    tMin = Math.max(tMin, near);
    tMax = Math.min(tMax, far);
    if (tMin > tMax) return false;
  }
  return tMax > 0 && tMin < 1;
}

/** 轴对齐遮挡盒(12 三角,外向绕序;shadowRayGpuCases.boxBlas 同式,本地内联)。 */
function visibilityOccluderBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): RayBlasDescriptor {
  const c = [[cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz + hz],
    [cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]];
  const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const vertices: number[] = [], indices: number[] = [];
  quads.forEach((quad, qi) => {
    const base = qi * 4;
    quad.forEach(cI => vertices.push(...c[cI]!));
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  });
  return { id: "mega-visibility-occluder", vertices: Float32Array.from(vertices),
    indices: Uint32Array.from(indices) };
}

/** MegaLight → PointLight(可见性腿单灯构造;打包端 ClusteredLights 入口)。 */
function toPointLight(light: { positionView: LightVector3; color: LightVector3; intensity: number }): PointLight {
  return { positionView: light.positionView, range: 0, color: light.color, intensity: light.intensity, decay: 2 };
}

export async function winnerVisibilityLeg(): Promise<Record<string, unknown>> {
  const device = await requestDevice();
  device.addEventListener?.("uncapturederror", (event) => {
    console.error("[uncapturederror]", (event as GPUUncapturedErrorEvent).error.message);
  });
  const runtime = new MegaLightsRuntime(shimSession(device), { visibility: {} });
  try {
    const width = VIS_WIDTH, height = VIS_HEIGHT;
    const surfaces = buildVisibilitySurfaces(width, height);
    // 场景:单点光(视空间) + 遮挡盒(世界 == 视空间,viewToWorld 恒等)。
    const packed = packMegaLights(megaLightsFromClustered({ points: [{
      positionView: [0.3, 0.4, -1.4], range: 0, color: [1, 1, 1], intensity: 3, decay: 2 }] }));
    const occluder = visibilityOccluderBox(-0.55, -0.1, -2.2, 0.45, 0.38, 0.08);
    const instances: TlasInstanceDescriptor[] = [{ id: occluder.id, blas: occluder,
      worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const, mask: 1 }];
    const scene = packTlasScene(buildTlas(instances));
    const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // CPU oracle 射线(与 deepMegaWriteWinnerRay 同式:origin 外推 + tMax 双侧收缩)。
    const lightRayOracle = (x: number, y: number) => {
      const world = [(x / width - 0.5) * 3.2, (0.5 - y / height) * 1.8, -3];
      const delta = [0.3 - world[0]!, 0.4 - world[1]!, -1.4 - world[2]!];
      const distance = Math.hypot(...delta);
      const dir = delta.map(component => component / distance);
      const epsilon = distance * 1e-3;
      return { origin: [world[0]! + dir[0]! * epsilon, world[1]! + dir[1]! * epsilon, world[2]! + dir[2]! * epsilon],
        dir, tMax: distance - epsilon - epsilon };
    };
    const visibilityInput = { scene, viewToWorld: identity, rayMask: 0xffffffff };
    const resources = { width, height, lightCount: packed.count, visibilityEnabled: false };
    const visResources = { ...resources, visibilityEnabled: true };

    // 相位 A:可见性关(基线亮度;同 runtime 翻开关位 = prepare 不带 visibility)。
    runtime.prepare({ width, height, lights: packed, surfaces, temporalEnabled: true,
      spatialEnabled: true, alphaBlend: 1 });
    await runFrame(device, runtime, resources, false);
    const baseline = await readbackColor(device, runtime);
    // 相位 B:可见性开,EMA 收敛 40 帧。
    const frameTimes: number[] = [];
    for (let frame = 0; frame < 40; frame++) {
      runtime.prepare({ width, height, lights: packed, surfaces, temporalEnabled: true,
        spatialEnabled: true, alphaBlend: frame === 0 ? 1 : 1 / 32, visibility: visibilityInput });
      frameTimes.push(await runFrame(device, runtime, visResources, frame >= 8));
    }
    const shadowed = await readbackColor(device, runtime);
    // mask buffer 直读(trace pass 原始输出;独立于 color,shade 末尾不清)。
    const maskBufferDump = await (async (): Promise<Float32Array> => {
      const buf = device.createBuffer({ label: "MegaLights probe mask readback", size: width * height * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const enc = device.createCommandEncoder({ label: "MegaLights probe mask readback" });
        enc.copyBufferToBuffer((runtime as unknown as { resources?: { visibilityMask?: GPUBuffer } })
          .resources!.visibilityMask!, 0, buf, 0, width * height * 4);
        device.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        return new Float32Array(buf.getMappedRange().slice(0));
      } finally { buf.destroy(); }
    })();
    let maskBufOccluded = 0;
    for (let pixel = 0; pixel < width * height; pixel++) { if (maskBufferDump[pixel] === 0) maskBufOccluded++; }
    // mask 证据:首帧(alpha=1)后的 color.w 直读 = 纯 trace pass 输出(未混 EMA)。
    runtime.prepare({ width, height, lights: packed, surfaces, temporalEnabled: false,
      spatialEnabled: true, alphaBlend: 1, visibility: visibilityInput });
    await runFrame(device, runtime, visResources, false);
    const maskDump = await readbackColor(device, runtime);
    let oracleOccluded = 0, maskOracleAgree = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x;
        const world = [(x / width - 0.5) * 3.2, (0.5 - y / height) * 1.8, -3];
        const occluded = segmentHitsBox([0.3, 0.4, -1.4], world, [-0.55, -0.1, -2.2], [0.45, 0.38, 0.08]);
        // mask buffer 与 CPU f64 oracle 逐像素对拍(1u=可见/0u=遮挡)。
        if ((maskBufferDump[pixel] === 0) === occluded) maskOracleAgree++;
        if (occluded) oracleOccluded++;
      }
    }
    // 哨兵读回(fail-closed 通道;生产循环不调)。
    const sentinelBuffer = device.createBuffer({ label: "MegaLights probe visibility sentinel",
      size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const sentinelEncoder = device.createCommandEncoder({ label: "MegaLights probe sentinel" });
    runtime.readbackStackOverflows(sentinelEncoder, sentinelBuffer);
    device.queue.submit([sentinelEncoder.finish()]);
    await sentinelBuffer.mapAsync(GPUMapMode.READ);
    const overflowSentinel = new Uint32Array(sentinelBuffer.getMappedRange().slice(0))[0]!;
    sentinelBuffer.destroy();

    // CPU f64 oracle 分区:阴影内部(线段穿盒,且 4% 回缩点已脱离盒 → 非边界)。
    const boxCenter = [-0.55, -0.1, -2.2], boxHalf = [0.45, 0.38, 0.08];
    const lightPos = [0.3, 0.4, -1.4];
    let shadowPixels = 0, shadowMeanOn = 0, shadowMeanOff = 0;
    let litPixels = 0, litMeanOn = 0, litMeanOff = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x;
        const world = [(x / width - 0.5) * 3.2, (0.5 - y / height) * 1.8, -3];
        const occluded = segmentHitsBox(lightPos, world, boxCenter, boxHalf);
        const on = shadowed[pixel * 4]! + shadowed[pixel * 4 + 1]! + shadowed[pixel * 4 + 2]!;
        const off = baseline[pixel * 4]! + baseline[pixel * 4 + 1]! + baseline[pixel * 4 + 2]!;
        if (occluded) {
          // 边界剔除:4% 回缩点若已不穿盒 → 半影/边界像素,不计入阴影内部。
          const pulled = [world[0]! + (lightPos[0]! - world[0]!) * 0.04,
            world[1]! + (lightPos[1]! - world[1]!) * 0.04, world[2]!];
          if (!segmentHitsBox(lightPos, pulled, boxCenter, boxHalf)) continue;
          shadowPixels++; shadowMeanOn += on; shadowMeanOff += off;
          continue;
        }
        // 亮区:外扩 0.06 仍不穿盒(远离阴影边界,空间复用/半影不沾)。
        const away = segmentHitsBox(lightPos, world, boxCenter,
          [boxHalf[0]! + 0.06, boxHalf[1]! + 0.06, boxHalf[2]! + 0.06]);
        if (!away) {
          litPixels++; litMeanOn += on; litMeanOff += off;
        }
      }
    }
    shadowMeanOn /= Math.max(shadowPixels, 1);
    shadowMeanOff /= Math.max(shadowPixels, 1);
    litMeanOn /= Math.max(litPixels, 1);
    litMeanOff /= Math.max(litPixels, 1);
    const shadowSuppression = shadowMeanOff > 1e-6 ? shadowMeanOn / shadowMeanOff : 1;
    const litRelativeDiff = litMeanOff > 1e-6 ? Math.abs(litMeanOn - litMeanOff) / litMeanOff : 0;
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const visP50 = sorted[Math.floor(sorted.length * 0.5)] ?? Number.NaN
    const visP95 = sorted[Math.floor(sorted.length * 0.95)] ?? Number.NaN
    const compileMessages = await compilationMessages(runtime);
    if (compileMessages.length) console.error("[compilation]", compileMessages.join(" | "));
    return { action: "megalights-winner-visibility", compileMessages,
      shadow: { pixels: shadowPixels, meanOn: shadowMeanOn, meanOff: shadowMeanOff,
        suppressionRatio: shadowSuppression, gate: 0.02, pass: shadowSuppression <= 0.02 },
      lit: { pixels: litPixels, meanOn: litMeanOn, meanOff: litMeanOff,
        relativeDiff: litRelativeDiff, gate: 0.02, pass: litRelativeDiff <= 0.02 },
      maskEvidence: { samples: width * height, gpuOccludedFraction: maskBufOccluded / (width * height),
        oracleOccludedFraction: oracleOccluded / (width * height),
        agreement: maskOracleAgree / (width * height), gate: 0.999,
        pass: maskOracleAgree / (width * height) >= 0.999 },
      sceneStats: (() => { const tlasBuild = buildTlas(instances); return {
        instanceCount: scene.instanceCount, tlasNodeCount: scene.tlasNodeCount,
        blasNodeCount: scene.blasNodeCount, triangleCount: scene.triangleCount,
        nodeBytes: scene.nodeBytes.byteLength, orderLen: tlasBuild.built.order.length,
        cpuArbitration: ([[80, 90], [160, 90], [200, 90]] as const).map(([x, y]) => {
          const ray = lightRayOracle(x, y);
          const hit = traceTlasClosest(tlasBuild, { ox: ray.origin[0]!, oy: ray.origin[1]!,
            oz: ray.origin[2]!, dx: ray.dir[0]!, dy: ray.dir[1]!, dz: ray.dir[2]!, tMax: ray.tMax });
          return { pixel: [x, y], hit: hit !== undefined, t: hit?.t ?? null };
        }) }; })(),
      overflowSentinel, perfMs: { p50: visP50, p95: visP95, width, height, frames: frameTimes.length },
      pass: shadowSuppression <= 0.02 && litRelativeDiff <= 0.02 && overflowSentinel === 0
        && Number.isFinite(visP95) && maskOracleAgree / (width * height) >= 0.999 };
  } finally { runtime.dispose(); }
}

// ---- ⑦ 生产供给 perf:M2 三趟(RIS 两趟 + 胜者遮挡 trace)@5000 灯 1080p ----

/** 可见性 perf 场景:灯与灯之间、墙(z=−3)与灯阵之间的遮挡盒阵(trace 有真实命中)。 */
function visibilityPerfScene(): ReturnType<typeof packTlasScene> {
  const boxes = [
    visibilityOccluderBox(-1.1, 0.4, -1.7, 0.5, 0.6, 0.05),
    visibilityOccluderBox(0.2, 0.6, -1.4, 0.6, 0.7, 0.05),
    visibilityOccluderBox(1.3, 0.3, -1.9, 0.45, 0.55, 0.05),
  ];
  const instances: TlasInstanceDescriptor[] = boxes.map((box, index) => ({ id: box.id, blas: box,
    worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const, mask: 1 }));
  return packTlasScene(buildTlas(instances));
}

/** 掩码读回(遮挡像素占比 = trace 真实命中的直接证据;perf 腿末尾采样一次)。 */
async function readbackVisibilityMask(device: GPUDevice, runtime: MegaLightsRuntime): Promise<Uint32Array> {
  const pixels = runtime.pixelCount;
  const buffer = device.createBuffer({ label: "MegaLights visibility perf mask readback",
    size: pixels * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const source = (runtime as unknown as { resources?: { visibilityMask?: GPUBuffer } }).resources
      ?.visibilityMask;
    if (!source) throw new Error("visibility perf leg requires a visibility allocation.");
    const encoder = device.createCommandEncoder({ label: "MegaLights visibility perf mask" });
    encoder.copyBufferToBuffer(source, 0, buffer, 0, pixels * 4);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    return new Uint32Array(buffer.getMappedRange().slice(0));
  } finally { buffer.destroy(); }
}

/**
 * 生产供给 perf 腿(双口径四相位,2026-10-05):
 *   先例口径(spatial off,同 M1 perf 腿):可见性关 → 开,绝对 p95 ≤ 20ms 门
 *   (≤20ms 先例在自身口径下带 trace 复验);
 *   生产口径(spatial on,生产控制器缺省):可见性关 → 开,trace 增量披露
 *   (生产绝对帧时口径含空间复用,先于本切片已 >20ms,如实披露不混报)。
 * 证据:四相位 p50/p95、trace 增量、掩码遮挡占比、哨兵零。
 */
export async function visibilityPerfLeg(): Promise<Record<string, unknown>> {
  const device = await requestDevice();
  device.addEventListener?.("uncapturederror", (event) => {
    console.error("[uncapturederror]", (event as GPUUncapturedErrorEvent).error.message);
  });
  const runtime = new MegaLightsRuntime(shimSession(device), { visibility: {} });
  try {
    const width = PERF_WIDTH, height = PERF_HEIGHT;
    const surfaces = buildPerfSurfaces(width, height);
    const scene = visibilityPerfScene();
    const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const visibilityInput = { scene, viewToWorld: identity, rayMask: 0xffffffff };
    const compileMessages = await compilationMessages(runtime);
    const phase = async (visibility: boolean, spatial: boolean): Promise<number[]> => {
      const times: number[] = [];
      for (let frame = 0; frame < 70; frame++) {
        const packed = packMegaLights(megaLightsFromClustered(buildPerfLights(frame)));
        runtime.prepare({ width, height, lights: packed, surfaces, temporalEnabled: true,
          spatialEnabled: spatial, alphaBlend: frame === 0 ? 1 : 1 / 32,
          ...(visibility ? { visibility: visibilityInput } : {}) });
        const elapsed = await runFrame(device, runtime,
          { width, height, lightCount: packed.count, visibilityEnabled: visibility }, frame >= 10);
        if (frame >= 10) times.push(elapsed);
      }
      return times;
    };
    const summary = (values: readonly number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      const percentile = (fraction: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
      return { samples: values.length, p50: percentile(0.5), p95: percentile(0.95),
        max: sorted[sorted.length - 1]!,
        mean: values.reduce((total, value) => total + value, 0) / values.length };
    };
    // 先例口径(同 M1 perf 腿 spatial off):关 → 开。
    const precedentOff = summary(await phase(false, false));
    const precedentOn = summary(await phase(true, false));
    // 生产口径(spatial on,控制器缺省):关 → 开。
    const productionOff = summary(await phase(false, true));
    const productionOn = summary(await phase(true, true));
    const mask = await readbackVisibilityMask(device, runtime);
    let occluded = 0;
    for (let pixel = 0; pixel < mask.length; pixel++) { if (mask[pixel] === 0) occluded++; }
    const sentinelBuffer = device.createBuffer({ label: "MegaLights visibility perf sentinel",
      size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const sentinelEncoder = device.createCommandEncoder({ label: "MegaLights visibility perf sentinel" });
    runtime.readbackStackOverflows(sentinelEncoder, sentinelBuffer);
    device.queue.submit([sentinelEncoder.finish()]);
    await sentinelBuffer.mapAsync(GPUMapMode.READ);
    const overflowSentinel = new Uint32Array(sentinelBuffer.getMappedRange().slice(0))[0]!;
    sentinelBuffer.destroy();
    const increment = (off: ReturnType<typeof summary>, on: ReturnType<typeof summary>) =>
      ({ p50: on.p50 - off.p50, p95: on.p95 - off.p95 });
    return { action: "megalights-production-visibility-perf", width, height,
      lightCount: PERF_LIGHT_COUNT, compileMessages,
      precedentSpatialOff: { off: precedentOff, on: precedentOn },
      productionSpatialOn: { off: productionOff, on: productionOn },
      traceIncrementMs: { precedent: increment(precedentOff, precedentOn),
        production: increment(productionOff, productionOn) },
      occludedFraction: occluded / mask.length, overflowSentinel,
      pass: precedentOn.p95 <= 20 && (productionOn.p95 - productionOff.p95) <= 4
        && overflowSentinel === 0 && occluded > 0 && compileMessages
          .every(message => message.startsWith("info")),
      gate: "先例口径(spatial off)带 trace 绝对 p95 ≤ 20ms + 生产口径(spatial on)trace 增量 p95 ≤ 4ms"
        + "+ 哨兵零 + trace 真实命中;生产口径绝对帧时先于本切片已 >20ms(空间复用主项),如实披露" };
  } finally { runtime.dispose(); }
}
