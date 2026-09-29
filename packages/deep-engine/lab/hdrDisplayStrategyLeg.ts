import {
  DEFAULT_EXTENDED_HEADROOM, DEFAULT_PQ_PEAK_NITS, HDR_REFERENCE_WHITE_NITS,
  type HdrDisplayStrategy,
} from "../src/webgpu/hdrDisplayOutput.js";
import { extendedLinearHeadroom, linearNitsToPq, linearToHlg, pqToLinearNits,
  quantifyHdrVsSdr } from "../src/webgpu/pbrHdrDisplay.js";
import { WIDTH, HEIGHT, authorBindGroup, copyTextureReadback, decodeRgba16float,
  ensureSession, rampSource, writeStrategySettings } from "./hdrDisplayProbeSession.js";
import type { StrategyLegResult } from "./hdrDisplayProbeTypes.js";

/**
 * I-C21 真机探针 —— SDR vs HDR 策略对照腿(从 hdrDisplayGpuProbe 按职责拆出):
 * 同一份 0..8 线性斜坡经既有 SDR outputShader 与 HDR 变体管线分别编码,离屏读回后做
 * 亮度/色域数值对照 + GPU↔CPU 编码镜像对拍 + 各策略可测特征判据。
 */

type Check = { readonly name: string; readonly passed: boolean; readonly detail: string };

/** 腿 2:SDR vs 指定 HDR 策略(同一斜坡源)的数值对照 + GPU↔CPU 镜像对拍。 */
export async function runStrategyLeg(strategy: HdrDisplayStrategy): Promise<StrategyLegResult> {
  const probe = await ensureSession();
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string): void => { checks.push({ name, passed, detail }); };

  // SDR 腿:bgra8unorm 目标,既有 outputShader(ACES+sRGB)编码。
  const sampler = probe.device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const sdrBind = probe.device.createBindGroup({ layout: probe.sdrPipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: probe.sourceRamp.createView() },
    { binding: 1, resource: sampler },
    { binding: 2, resource: { buffer: probe.settingsBuffer } },
  ] });
  const sdrEncoder = probe.device.createCommandEncoder();
  const sdrPass = sdrEncoder.beginRenderPass({ colorAttachments: [{ view: probe.sdrTarget.createView(),
    loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
  sdrPass.setPipeline(probe.sdrPipeline);
  sdrPass.setBindGroup(0, sdrBind);
  sdrPass.setBindGroup(1, probe.device.createBindGroup({
    layout: probe.sdrPipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: probe.authorBuffer } }] }));
  sdrPass.draw(3);
  sdrPass.end();
  probe.device.queue.submit([sdrEncoder.finish()]);
  const sdrBytes = await copyTextureReadback(probe.device, probe.sdrTarget, WIDTH * 4);
  add("sdr:rendered", sdrBytes.length === WIDTH * HEIGHT * 4, `bytes=${sdrBytes.length}`);
  // SDR 高光行为:最后 8 列(线性 7.5..8)应被 ACES 压成近白且色度抹平。
  let tailMax = 0, tailSpread = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = WIDTH - 8; x < WIDTH; x += 1) {
      const base = (y * WIDTH + x) * 4;
      const r = sdrBytes[base]!, g = sdrBytes[base + 1]!, b = sdrBytes[base + 2]!;
      tailMax = Math.max(tailMax, r, g, b);
      tailSpread = Math.max(tailSpread, Math.abs(r - g), Math.abs(g - b));
    }
  }
  add("sdr:highlights-clamp-to-white", tailMax >= 250, `tailMax8bit=${tailMax}(ACES 渐近白)`);
  add("sdr:highlight-chroma-flattened", tailSpread <= 6, `tailMaxChannelSpread=${tailSpread}(超白域色度被吞)`);

  // HDR 腿:rgba16float 目标,HDR 变体编码。
  writeStrategySettings(probe, strategy);
  const runtime = probe.hdrPipelines.get(strategy);
  if (!runtime) throw new Error(`HDR pipeline for ${strategy} missing.`);
  const hdrBind = probe.device.createBindGroup({ layout: runtime.bindGroupLayout, entries: [
    { binding: 0, resource: probe.sourceRamp.createView() },
    { binding: 1, resource: sampler },
    { binding: 2, resource: { buffer: probe.settingsBuffer } },
    { binding: 3, resource: { buffer: runtime.hdrSettingsBuffer } },
  ] });
  const hdrEncoder = probe.device.createCommandEncoder();
  const hdrPass = hdrEncoder.beginRenderPass({ colorAttachments: [{ view: probe.hdrTarget.createView(),
    loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
  hdrPass.setPipeline(runtime.pipeline);
  hdrPass.setBindGroup(0, hdrBind);
  hdrPass.setBindGroup(1, authorBindGroup(probe));
  hdrPass.draw(3);
  hdrPass.end();
  probe.device.queue.submit([hdrEncoder.finish()]);
  const hdrBytes = await copyTextureReadback(probe.device, probe.hdrTarget, WIDTH * 8);
  const hdrPixels = decodeRgba16float({ width: WIDTH, height: HEIGHT, bytesPerRow: WIDTH * 8, bytes: hdrBytes });
  add("hdr:rendered", hdrPixels.length === WIDTH * HEIGHT * 4, `floats=${hdrPixels.length}`);

  const { linear } = rampSource();
  const quantification = quantifyHdrVsSdr(linear, {
    referenceWhiteNits: HDR_REFERENCE_WHITE_NITS, pqPeakNits: DEFAULT_PQ_PEAK_NITS,
    extendedHeadroom: DEFAULT_EXTENDED_HEADROOM,
  });

  // GPU ↔ CPU 镜像对拍:中部一行抽 16 列 × 3 通道(f16 量化容差 1%)。
  let worst = 0, compared = 0;
  const columns = [0, 8, 16, 32, 48, 63, 72, 80, 88, 96, 104, 111, 118, 124, 125, 127];
  for (const x of columns) {
    const y = HEIGHT >> 1;
    const value = (x / (WIDTH - 1)) * 8;
    const pixel = (y * WIDTH + x) * 4;
    for (const [channel, scale] of [[0, 1], [1, 0.8], [2, 1.2]] as const) {
      const source = value * scale;
      const expected = strategy === "extended-linear"
        ? extendedLinearHeadroom(source, DEFAULT_EXTENDED_HEADROOM)
        : strategy === "pq-2020"
          ? linearNitsToPq(Math.min(source * HDR_REFERENCE_WHITE_NITS, DEFAULT_PQ_PEAK_NITS))
          : linearToHlg(source);
      const actual = hdrPixels[pixel + channel]!;
      worst = Math.max(worst, Math.abs(actual - expected) / Math.max(Math.abs(expected), 0.05));
      compared += 1;
    }
  }
  add("hdr:cpu-mirror", worst <= 0.01, `maxRel=${worst.toExponential(3)} compared=${compared}`);

  // 量化判据:HDR 策略各自的可测特征。
  const tailValues = [...Array(8).keys()].map((_, index) =>
    hdrPixels[((HEIGHT >> 1) * WIDTH + WIDTH - 1 - index) * 4]!);
  const tailPeak = Math.max(...tailValues);
  if (strategy === "pq-2020") {
    const decodedPeak = pqToLinearNits(tailPeak);
    add("quant:pq-decodes-to-nits", Math.abs(decodedPeak - DEFAULT_PQ_PEAK_NITS) / DEFAULT_PQ_PEAK_NITS <= 0.02,
      `decodedPeakNits=${decodedPeak.toFixed(1)} expected=${DEFAULT_PQ_PEAK_NITS}`);
    add("quant:pq-above-sdr-white", decodedPeak > 4 * HDR_REFERENCE_WHITE_NITS,
      `decodedPeakNits=${decodedPeak.toFixed(0)} >> sdr ${HDR_REFERENCE_WHITE_NITS}nits`);
  }
  if (strategy === "extended-linear") {
    add("quant:extended-preserves-headroom",
      tailPeak > 1 && tailPeak <= DEFAULT_EXTENDED_HEADROOM * 1.2 + 1e-3,
      `encodedPeak=${tailPeak.toFixed(4)}(headroom 顶=${(DEFAULT_EXTENDED_HEADROOM * 1.2).toFixed(2)})`);
  }
  if (strategy === "hlg-2020") {
    add("quant:hlg-nominal-range", tailPeak > 0.9 && tailPeak <= 1.0 + 1e-3,
      `encodedPeak=${tailPeak.toFixed(4)}(HLG 标称顶=1.0)`);
  }
  return {
    strategy, checks,
    quantification: { ...(quantification as object),
      gpu: { tailPeakEncoded: tailPeak, cpuMirrorMaxRel: worst,
        sdrTailMax8bit: tailMax, sdrTailChannelSpread: tailSpread,
        sdrRowProfile8bitR: [0, 8, 16, 32, 48, 64, 80, 96, 112, 120, 127].map(x =>
          sdrBytes[((HEIGHT >> 1) * WIDTH + x) * 4]!) } },
  };
}
