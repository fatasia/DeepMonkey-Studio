/**
 * Brief-GI M1 验收证据生成器(2026-10-04,ue-class-b2-task-briefs §Brief-GI M1)。
 *
 * 产出 packages/deep-engine/test-output/gi/:
 * - day.png / night.png:1920×1080 昼/夜对比(物理大气天空,GI-only 着色;
 *   CPU 参考渲染 —— 生产 GPU 直出帧归真机联测,本图是探针场合同的像素证据);
 * - evidence.json:验收①④读数 + 场景烘焙报告 + 天光遮蔽统计 + 文件 sha256。
 *
 * 运行:node scripts/sdfGiEvidence.mjs(TS 经 scripts/lib/tsSourceModuleResolution.mjs
 * 加载,先例 scripts/rendererCapabilityManifest.test.mjs)。禁 commit 产物按仓库惯例
 * (test-output 不入版本库,哈希写入本 JSON)。
 */
import "./lib/tsSourceModuleResolution.mjs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const engine = "packages/deep-engine";
const outDir = new URL(`../${engine}/test-output/gi/`, import.meta.url);

const { createSdfGiDayNightState, stepSdfGiDayNightFrame, dayNightSunDirectionEnu,
  referenceRoomBakeInstances } = await import(
  pathToFileURL("D:/Documents/bim/bim-studio/packages/deep-engine/src/gi/sdfGiDayNight.ts").href);
const { shadeSdfGiFrame, frameDiffP99, SDF_GI_DEFAULT_CAMERA } = await import(
  pathToFileURL("D:/Documents/bim/bim-studio/packages/deep-engine/src/gi/sdfGiShade.ts").href);
const { sampleAtmosphereSkyRadiance, atmosphereSunTransmittance } = await import(
  pathToFileURL("D:/Documents/bim/bim-studio/packages/deep-engine/src/environment/atmosphereSky.ts").href);
const { MAX_SDF_PROFILE_GRID_CELLS } = await import(
  pathToFileURL("D:/Documents/bim/bim-studio/packages/deep-engine/src/physics/sdfCollisionProfile.ts").href);

const TURBIDITY = 3;
const WIDTH = 1920, HEIGHT = 1080;
const WARMUP_FRAMES = 32;

function skyFor(azimuthDegrees) {
  const sun = dayNightSunDirectionEnu(azimuthDegrees);
  const parameters = { turbidity: TURBIDITY, sunDirectionEnu: sun };
  return {
    sun,
    sample: (directionEnu) => sampleAtmosphereSkyRadiance(parameters, directionEnu),
    transmittance: () => atmosphereSunTransmittance(parameters),
  };
}

/** CRC32(PNG chunk 用;查表实现)。 */
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** RGBA8 → PNG(过滤 0,zlib deflate)。 */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

mkdirSync(outDir, { recursive: true });
const evidence = {
  generatedAt: new Date().toISOString(),
  task: "Brief-GI M1:静态 SDF 遮蔽 + 动态探针混合 GI(ue-class-b2-task-briefs-20261004)",
  scene: "参考房间(薄墙+门洞+天窗,12×AABB 静态盒,instanceDomain=scene)",
  sky: `物理大气 atmosphereSky(turbidity=${TURBIDITY},仰角=22°·sin(方位角),地平下自然入夜)`,
  shading: "GI-only(CPU 参考:反照率×探针 GI + 物理天空背景;不含直射项,见 sdfGiShade.ts 头注)",
  gates: {},
  artifacts: {},
};

// ── 烘焙与天光遮蔽静态证据 ────────────────────────────────────────────────
const state = createSdfGiDayNightState({ directionCount: 16 });
const bake = state.bake;
let openCount = 0;
for (const value of state.visibility) if (value >= 0.5) openCount++;
evidence.bake = {
  cellSize: bake.report.cellSize,
  dimensions: bake.report.dimensions,
  cells: bake.memory.cells,
  cellsBudget: MAX_SDF_PROFILE_GRID_CELLS,
  fieldBytes: bake.memory.fieldBytes,
  bakedCount: bake.report.bakedCount,
  excludedDynamicCount: bake.report.excludedDynamicCount,
  skippedCount: bake.report.skippedCount,
  skyVisibility: { probes: state.probes.length,
    directions: state.directions.length,
    openRatio: Number((openCount / state.visibility.length).toFixed(4)) },
};

// ── 昼/夜 1080p 帧 ───────────────────────────────────────────────────────
const CAMERA = { position: [6.8, 2.5, 4.9], target: [1.6, 0.2, 2.6], fovDegrees: 62 };
const EXPOSURE = 7;

function directSunFor(sunEnu) {
  const transmittance = atmosphereSunTransmittance(
    { turbidity: TURBIDITY, sunDirectionEnu: sunEnu });
  const meanT = (transmittance[0] + transmittance[1] + transmittance[2]) / 3;
  return sunEnu[2] > 0
    ? { directionYUp: [sunEnu[0], sunEnu[2], sunEnu[1]], intensity: 20 * meanT }
    : { directionYUp: [0, 1, 0], intensity: 0 };
}

function renderFrame(azimuthDegrees) {
  const sky = skyFor(azimuthDegrees);
  const directSun = directSunFor(sky.sun);
  for (let frame = 0; frame < WARMUP_FRAMES; frame++) {
    stepSdfGiDayNightFrame(state, azimuthDegrees, sky.sample, undefined, directSun);
  }
  const started = performance.now();
  const shaded = shadeSdfGiFrame(state, {
    width: WIDTH, height: HEIGHT, camera: CAMERA, skyRadiance: sky.sample, exposure: EXPOSURE,
  });
  return { shaded, renderMillis: performance.now() - started,
    transmittance: sky.transmittance(), sun: sky.sun };
}

const day = renderFrame(90);   // 太阳仰角 +22°
const night = renderFrame(270); // 太阳仰角 −22°(地平下,自然入夜)

const dayPng = encodePng(day.shaded.rgba, WIDTH, HEIGHT);
const nightPng = encodePng(night.shaded.rgba, WIDTH, HEIGHT);
writeFileSync(new URL("day.png", outDir), dayPng);
writeFileSync(new URL("night.png", outDir), nightPng);
evidence.artifacts["day.png"] = { size: dayPng.length, sha256: sha256(dayPng),
  sunElevationDeg: Number((Math.asin(day.sun[2]) * 180 / Math.PI).toFixed(2)),
  hitRatio: Number(day.shaded.hitRatio.toFixed(4)),
  renderMillis: Number(day.renderMillis.toFixed(1)) };
evidence.artifacts["night.png"] = { size: nightPng.length, sha256: sha256(nightPng),
  sunElevationDeg: Number((Math.asin(night.sun[2]) * 180 / Math.PI).toFixed(2)),
  hitRatio: Number(night.shaded.hitRatio.toFixed(4)),
  renderMillis: Number(night.renderMillis.toFixed(1)) };

// ── 验收①:昼夜循环连续帧差(p99,480×270 采样,含日出最陡段) ─────────────
{
  const seqState = createSdfGiDayNightState({ directionCount: 16 });
  const width = 480, height = 270;
  const shade = (azimuth) => {
    const sky = skyFor(azimuth);
    stepSdfGiDayNightFrame(seqState, azimuth, sky.sample, undefined, directSunFor(sky.sun));
    return shadeSdfGiFrame(seqState, { width, height, camera: CAMERA,
      skyRadiance: sky.sample, exposure: EXPOSURE }).rgba;
  };
  for (let frame = 0; frame < 16; frame++) shade(0);
  let previous = shade(0);
  let worst = 0;
  const perFrame = [];
  for (let frame = 1; frame <= 12; frame++) {
    const current = shade(frame * 0.25);
    const p99 = frameDiffP99(previous, current);
    perFrame.push(p99);
    worst = Math.max(worst, p99);
    previous = current;
  }
  evidence.gates.frameDiffP99 = { budget: 3, worst, perFrame,
    pass: worst <= 3,
    note: "0.25°/帧(全循环 1440 帧 = 60fps 24s);预热 16 帧分离收敛瞬态;含日出最陡段" };
}

// ── 验收④:探针 SH 更新帧预算(p95,252 探针 × 16 方向,CPU 侧) ────────────
{
  const budgetState = createSdfGiDayNightState({ directionCount: 16 });
  const sky = skyFor(45);
  const ssgdi = (await import(
    pathToFileURL("D:/Documents/bim/bim-studio/packages/deep-engine/src/gi/sdfGiDayNight.ts").href))
    .computeSdfGiDynamicDirectField(budgetState);
  budgetState.updateMillis.length = 0;
  for (let frame = 0; frame < 24; frame++) {
    stepSdfGiDayNightFrame(budgetState, 45, sky.sample, ssgdi);
  }
  const sorted = [...budgetState.updateMillis].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const production = { probes: 6144, directionCount: 32,
    analyticGpuConeTraceSamples: 6144 * 32 * 8,
    note: "GPU 圆锥追踪 1.57M 次 trilinear 采样/帧(≈0.5ms 级 @1080p 离散卡);真机帧时归 GPU 联测,本表为 CPU 侧链路预算" };
  evidence.gates.frameBudget = { budgetMillis: 6, p95Millis: Number(p95.toFixed(3)),
    pass: p95 < 6, probes: budgetState.probes.length, productionEstimate: production };
}

writeFileSync(new URL("evidence.json", outDir),
  JSON.stringify(evidence, null, 2) + "\n");
console.log("evidence written:", evidence.gates.frameDiffP99.worst,
  evidence.gates.frameBudget.p95Millis);
console.log(`bake cells=${evidence.bake.cells} baked=${evidence.bake.bakedCount}`);
console.log(`day sha=${evidence.artifacts["day.png"].sha256.slice(0, 12)} night sha=${evidence.artifacts["night.png"].sha256.slice(0, 12)}`);
