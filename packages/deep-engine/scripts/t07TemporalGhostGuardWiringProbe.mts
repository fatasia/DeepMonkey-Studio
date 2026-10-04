import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TEMPORAL_AA_WGSL } from "../src/postprocess/temporalAaWgsl.ts";
import { TEMPORAL_UPSCALE_WGSL } from "../src/postprocess/temporalUpscaleWgsl.ts";
import { enableTemporalGhostGuardWgsl } from "../src/postprocess/temporalReprojection.ts";
import { buildAllSequences } from "../src/postprocess/temporalSequenceScenes.ts";
import { temporalAaJitter } from "../src/postprocess/temporalAaCpu.ts";
import { accumulateTemporalFrameDetailed, GHOST_GUARD_REPROJECTION_POLICY, measureGhostSequence } from "../src/postprocess/temporalReprojection.ts";
import { t07TemporalPageKernel } from "./t07TemporalGpuPageKernel.mjs";
import { temporalUpscaleWiringKernel } from "./t07TemporalUpscaleWiringKernel.mjs";
import { MOTION_WGSL, UPSAMPLE_WGSL } from "./t07TemporalKernelsWgsl.mjs";
import { base64, toF16RgbaBytes, f32Buffer, extractRgba, maxAbsDiff } from "./t07TemporalCodec.mts";

// AA-M2 接线逐位一致探针(真机 GPU,headless Chrome):生产 WGSL 接入 GHOST_GUARD
// 决策层后,证明 ①开关关(默认)输出与 git HEAD 历史生产 WGSL 逐字节一致(TAA 与
// 上采样两个核);②开关开为同一 WGSL 单字符翻转且残影能量过 3 帧门;③开与关在
// 决策触发像素上确实分流(开关不是摆设)。证据:test-output/deep-core/T07/
// ghost-guard-wiring-probe/evidence.json。

const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const outputDir = fileURLToPath(new URL("../../../test-output/deep-core/T07/ghost-guard-wiring-probe/", import.meta.url));

const OPTIONS = { feedback: 0.9, depthThreshold: 0.012, relativeDepthThreshold: 0.02 };

/** git HEAD 里的历史生产 WGSL(模板字面量提取;历史文件无嵌套反引号)。 */
function legacyWgsl(path: string): string {
  const source = execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8", cwd: fileURLToPath(new URL("../../..", import.meta.url)) });
  const match = source.match(/\/\* wgsl \*\/ `([\s\S]*)`;/);
  if (!match) throw new Error(`Legacy WGSL template not found in ${path}.`);
  return match[1]!;
}

/** 与 t07TemporalSequencesGpuTest.mts 同式的帧打包(探针自足,不改该脚本)。 */
const packFramePayload = (sequenceArg: ReturnType<typeof buildAllSequences>[number]) =>
  sequenceArg.frames.map((frame, index) => {
    const currentJitter = temporalAaJitter(index), previousJitter = temporalAaJitter(Math.max(0, index - 1));
    const rows = new Float32Array(sequenceArg.frames[index]!.relativeRows.length * 12);
    frame.relativeRows.forEach((rowGroup, object) => rows.set([...rowGroup[0], ...rowGroup[1], ...rowGroup[2]], object * 12));
    const matrices = new Float32Array(40);
    matrices.set([...frame.viewProjection], 0);
    matrices.set([...frame.previousViewProjection], 16);
    const jitterDeltaUv: [number, number] = [(previousJitter[0] - currentJitter[0]) / sequenceArg.width, (previousJitter[1] - currentJitter[1]) / sequenceArg.height];
    matrices.set([jitterDeltaUv[0], jitterDeltaUv[1], 0, 0], 32);
    matrices.set([sequenceArg.width, sequenceArg.height, frame.relativeRows.length, 0], 36);
    return { colorB64: base64(toF16RgbaBytes(frame.color)), depthB64: base64(f32Buffer(frame.depth)),
      worldB64: base64(f32Buffer(frame.world)), rowsB64: base64(new Uint8Array(rows.buffer)),
      matricesB64: base64(new Uint8Array(matrices.buffer)), historyValid: index > 0,
      jitterCur: currentJitter, jitterPrev: previousJitter, jitterDeltaUv };
  });

// 合成上采样输入:内部 64×64,反相细栅栏切换(触发 clamp+decay 深度匹配路径)+
// 右半深度跳变(触发 acceptedRatio=0 的 box fallback 路径)。零运动静态机位。
function buildUpscaleInput(width: number, height: number): { colorB64: string; depthB64: string; historyValid: boolean }[] {
  const pixels = width * height;
  const fence = (phase: number) => Float32Array.from({ length: pixels * 4 }, (_, i) =>
    i % 4 === 3 ? 1 : ((((i / 4 | 0) % width) - 2 * phase) % 4 + 4) % 4 < 2 ? 1 : 0);
  const depthA = Float32Array.from({ length: pixels }, (_, pixel) => pixel % width >= width / 2 ? 8 : 4);
  const depthB = Float32Array.from({ length: pixels }, () => 4);
  return [
    { colorB64: base64(toF16RgbaBytes(fence(1))), depthB64: base64(f32Buffer(depthA)), historyValid: false },
    { colorB64: base64(toF16RgbaBytes(fence(0))), depthB64: base64(f32Buffer(depthB)), historyValid: true },
  ];
}

const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" })
  .end("<html><body style=\"background:#101820\"></body></html>"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"] });
await mkdir(outputDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`http://127.0.0.1:${port}`);
  const legacyAa = legacyWgsl("packages/deep-engine/src/postprocess/temporalAaWgsl.ts");
  const legacyUpscale = legacyWgsl("packages/deep-engine/src/postprocess/temporalUpscaleWgsl.ts");
  const offAa = TEMPORAL_AA_WGSL, onAa = enableTemporalGhostGuardWgsl(TEMPORAL_AA_WGSL);
  const offUpscale = TEMPORAL_UPSCALE_WGSL, onUpscale = enableTemporalGhostGuardWgsl(TEMPORAL_UPSCALE_WGSL);
  const cases: Record<string, unknown>[] = [];

  // ①TAA:old(HEAD) vs 新关(逐字节)+ 新开(能量门 + 与关确实分流)。
  for (const sequenceArg of buildAllSequences()) {
    const framesPayload = packFramePayload(sequenceArg);
    const { width, height } = sequenceArg;
    const identityRun = await page.evaluate(t07TemporalPageKernel, { mode: "sequence", width, height,
      frames: framesPayload, options: OPTIONS, wgslTaa: legacyAa, wgslGuard: offAa, wgslMotion: MOTION_WGSL, wgslUpsample: UPSAMPLE_WGSL });
    if (identityRun.queueErrors.length) throw new Error(`${sequenceArg.name} identity: ${identityRun.queueErrors.join("; ")}`);
    const guardRun = await page.evaluate(t07TemporalPageKernel, { mode: "sequence", width, height,
      frames: framesPayload, options: OPTIONS, wgslTaa: offAa, wgslGuard: onAa, wgslMotion: MOTION_WGSL, wgslUpsample: UPSAMPLE_WGSL });
    if (guardRun.queueErrors.length) throw new Error(`${sequenceArg.name} guard: ${guardRun.queueErrors.join("; ")}`);
    const stride = identityRun.rowStride.color;
    const legacyFrames = identityRun.baselineFrames.map((frameB64: string) => Buffer.from(frameB64, "base64"));
    const offFrames = identityRun.guardFrames.map((frameB64: string) => Buffer.from(frameB64, "base64"));
    const onFrames = guardRun.guardFrames.map((frameB64: string) => Buffer.from(frameB64, "base64"));
    const offFramesForEnergy = guardRun.baselineFrames.map((frameB64: string) => Buffer.from(frameB64, "base64"));
    const byteIdentity = legacyFrames.every((frame, index) => frame.equals(offFrames[index]!));
    let onDivergedPixels = 0, onMaxDiff = 0;
    for (let index = 0; index < offFrames.length; index++) {
      const off = extractRgba(offFrames[index]!, width, height, stride);
      const on = extractRgba(onFrames[index]!, width, height, stride);
      if (!offFrames[index]!.equals(onFrames[index]!)) onDivergedPixels += width * height;
      onMaxDiff = Math.max(onMaxDiff, maxAbsDiff(off, on));
    }
    const ideals = sequenceArg.frames.map(frame => frame.color);
    const ghostOn = measureGhostSequence(
      onFrames.map((frame, index) => extractRgba(frame, width, height, stride)).slice(sequenceArg.moveFrames),
      ideals.slice(sequenceArg.moveFrames), sequenceArg.sourceContrast);
    const ghostOff = measureGhostSequence(
      offFramesForEnergy.map((frame, index) => extractRgba(frame, width, height, stride)).slice(sequenceArg.moveFrames),
      ideals.slice(sequenceArg.moveFrames), sequenceArg.sourceContrast);
    // CPU 镜像 guard 对照(接线后的 CPU 权威端不变)。
    let previousColor: Float32Array | undefined, previousDepth: number[] | undefined;
    const cpuGuard: Float32Array[] = [];
    framesPayload.forEach((frame, index) => {
      const input = { width, height, color: Array.from(sequenceArg.frames[index]!.color), depth: Array.from(sequenceArg.frames[index]!.depth),
        motion: Array.from(extractRgba(Buffer.from(identityRun.motionFrames[index]!, "base64"), width, height, identityRun.rowStride.motion)
          .reduce((motion: number[], value, position) => { if (position % 4 < 2) motion.push(value); return motion; }, [])),
        ...(frame.historyValid ? { previousColor: Array.from(previousColor!), previousDepth: Array.from(previousDepth!) } : {}),
        currentJitter: frame.jitterCur, previousJitter: frame.jitterPrev, historyValid: frame.historyValid };
      const output = accumulateTemporalFrameDetailed(input, OPTIONS, GHOST_GUARD_REPROJECTION_POLICY).output;
      cpuGuard.push(output); previousColor = output; previousDepth = sequenceArg.frames[index]!.depth;
    });
    const ghostCpu = measureGhostSequence(cpuGuard.slice(sequenceArg.moveFrames), ideals.slice(sequenceArg.moveFrames), sequenceArg.sourceContrast);
    const record = { name: sequenceArg.name, taaOffVsHeadByteIdentical: byteIdentity,
      taaOnDiverged: onDivergedPixels > 0, taaOnMaxDiffVsOff: Number(onMaxDiff.toPrecision(3)),
      ghostOffEnergies: ghostOff.energies.map(value => Number(value.toFixed(4))),
      ghostOnEnergies: ghostOn.energies.map(value => Number(value.toFixed(4))),
      ghostCpuEnergies: ghostCpu.energies.map(value => Number(value.toFixed(4))),
      onPassesWithin3Frames: ghostOn.passesWithin3Frames };
    cases.push(record);
    console.log(`${sequenceArg.name}: off==HEAD bytes ${byteIdentity}, on diverged ${onDivergedPixels > 0} (maxDiff ${onMaxDiff.toPrecision(3)}), `
      + `ghost on[3f]=${ghostOn.energies.map(v => v.toFixed(4)).join("/")} off[3f]=${ghostOff.energies.map(v => v.toFixed(4)).join("/")}`);
  }

  // ②上采样:old(HEAD) vs 新关(逐字节)+ 新开(确实分流)。合成栅栏+深度跳变输入。
  const upscaleInput = buildUpscaleInput(64, 64);
  const upscaleRun = await page.evaluate(temporalUpscaleWiringKernel, { width: 96, height: 96, internalWidth: 64, internalHeight: 64,
    frames: upscaleInput, options: OPTIONS, wgslLegacy: legacyUpscale, wgslOff: offUpscale, wgslOn: onUpscale });
  if ((upscaleRun.queueErrors as string[]).length) throw new Error(`upscale probe: ${(upscaleRun.queueErrors as string[]).join("; ")}`);
  const upscaleStride = upscaleRun.rowStride as number;
  const upscaleLegacy = (upscaleRun.legacyFrames as string[]).map(frameB64 => Buffer.from(frameB64, "base64"));
  const upscaleOff = (upscaleRun.offFrames as string[]).map(frameB64 => Buffer.from(frameB64, "base64"));
  const upscaleOn = (upscaleRun.onFrames as string[]).map(frameB64 => Buffer.from(frameB64, "base64"));
  const upscaleByteIdentity = upscaleLegacy.every((frame, index) => frame.equals(upscaleOff[index]!));
  let upscaleOnDivergedPixels = 0, upscaleOnMaxDiff = 0;
  for (let index = 0; index < upscaleOff.length; index++) {
    const off = extractRgba(upscaleOff[index]!, 96, 96, upscaleStride);
    const on = extractRgba(upscaleOn[index]!, 96, 96, upscaleStride);
    if (!upscaleOff[index]!.equals(upscaleOn[index]!)) upscaleOnDivergedPixels += 96 * 96;
    upscaleOnMaxDiff = Math.max(upscaleOnMaxDiff, maxAbsDiff(off, on));
  }
  const upscaleRecord = { name: "temporal-upscale(synthetic fence+depth-step)",
    upscaleOffVsHeadByteIdentical: upscaleByteIdentity, upscaleOnDiverged: upscaleOnDivergedPixels > 0,
    upscaleOnMaxDiffVsOff: Number(upscaleOnMaxDiff.toPrecision(3)) };
  cases.push(upscaleRecord);
  console.log(`upscale: off==HEAD bytes ${upscaleByteIdentity}, on diverged ${upscaleOnDivergedPixels > 0} (maxDiff ${upscaleOnMaxDiff.toPrecision(3)})`);

  const checks = {
    taaOffByteIdenticalAllScenes: cases.slice(0, -1).every(record => record.taaOffVsHeadByteIdentical === true),
    upscaleOffByteIdentical: upscaleByteIdentity,
    onVariantsDiverge: cases.slice(0, -1).every(record => record.taaOnDiverged === true) || upscaleOnDivergedPixels > 0,
    onPassesGhostGate: cases.slice(0, -1).every(record => record.onPassesWithin3Frames === true),
  };
  const evidence = { schema: "t07-ghost-guard-wiring-probe-v1", createdAt: new Date().toISOString(),
    lane: "aa-m2-ghost-guard-wiring",
    method: "git HEAD 历史 WGSL vs 生产 WGSL(编译期开关关)逐字节对拍 + 同 WGSL 开关开(残影能量门),真机 GPU headless Chrome;上采样核为合成栅栏+深度跳变输入的三链对拍",
    options: OPTIONS, cases, checks, verdict: { allPass: Object.values(checks).every(Boolean) } };
  await writeFile(`${outputDir}evidence.json`, JSON.stringify(evidence, null, 2));
  if (!evidence.verdict.allPass) process.exitCode = 1;
  console.log(`verdict allPass=${evidence.verdict.allPass}`);
} finally { await browser.close(); server.close(); }
