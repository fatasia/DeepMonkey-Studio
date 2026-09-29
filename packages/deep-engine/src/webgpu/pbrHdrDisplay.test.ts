import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXTENDED_HEADROOM, DEFAULT_PQ_PEAK_NITS, HDR_REFERENCE_WHITE_NITS } from "./hdrDisplayOutput.js";
import {
  cieXyFromLinearSrgb, extendedLinearHeadroom, GAMUT_PRIMARIES, hdrEncodeChannel, hdrSettingsUniform,
  HLG_A, HLG_B, HLG_C, linearNitsToPq, linearToHlg, pointInTriangle, pqToLinearNits,
  PQ_C1, PQ_C2, PQ_C3, PQ_M1, PQ_M2, quantifyHdrVsSdr,
} from "./pbrHdrDisplay.js";

const WGSL_SOURCE_PATH = fileURLToPath(new URL("./pbrHdrDisplayWgsl.ts", import.meta.url));

describe("I-C21 BT.2100 编码核 —— 规范锚点", () => {
  it("PQ:100 nits ≈ 码值 0.50808(BT.2100 标注点),往返解码闭合", () => {
    expect(linearNitsToPq(100)).toBeCloseTo(0.50808, 4);
    expect(linearNitsToPq(10000)).toBeCloseTo(1.0, 5);
    expect(linearNitsToPq(0)).toBe(0);
    for (const nits of [0.005, 1, 100, 203, 1000, 5000]) {
      expect(pqToLinearNits(linearNitsToPq(nits))).toBeCloseTo(nits, nits >= 1 ? 3 : 5);
    }
    expect(pqToLinearNits(linearNitsToPq(HDR_REFERENCE_WHITE_NITS))).toBeCloseTo(HDR_REFERENCE_WHITE_NITS, 3);
  });

  it("HLG:参考线性点与 BT.2100 示例一致(E=0.25 → 信号 ≈0.739)", () => {
    expect(linearToHlg(0)).toBe(0);
    expect(linearToHlg(1 / 12)).toBeCloseTo(0.5, 5);
    expect(linearToHlg(0.25)).toBeCloseTo(0.739, 3);
    expect(linearToHlg(1)).toBeCloseTo(1.0, 3);
    expect(linearToHlg(2)).toBeCloseTo(1.0, 5);
  });

  it("BT.2100 发表系数与派生关系一致(字面量即发表值)", () => {
    expect(PQ_M1).toBeCloseTo(0.1593017578125, 12);
    expect(PQ_M2).toBeCloseTo(78.84375, 9);
    expect(PQ_C1).toBeCloseTo(0.8359375, 12);
    expect(PQ_C2).toBeCloseTo(18.8515625, 9);
    expect(PQ_C3).toBeCloseTo(18.6875, 9);
    expect(1 - 4 * HLG_A).toBeCloseTo(HLG_B, 7);
    expect(0.5 - HLG_A * Math.log(4 * HLG_A)).toBeCloseTo(HLG_C, 7);
  });

  it("WGSL 源文本与 CPU 镜像系数逐位同源(文本级对拍,同 Rust 清单网先例)", () => {
    const source = readFileSync(WGSL_SOURCE_PATH, "utf8");
    for (const literal of ["0.1593017578125", "78.84375", "0.8359375", "18.8515625", "18.6875",
      "0.17883277", "0.28466892", "0.55991073"]) {
      expect(source, `WGSL literal ${literal}`).toContain(literal);
    }
    expect(source).toContain("clamp(nits, 0.0, 10000.0) / 10000.0");
    expect(source).toContain("sqrt(3.0 * e)");
    expect(source).toContain("tanh(over / vec3f(room))");
  });
});

describe("I-C21 extended-linear headroom 肩部", () => {
  it("≤1 直通,>1 软肩压向 headroom 顶且连续", () => {
    for (const value of [0, 0.25, 0.5, 1]) {
      expect(extendedLinearHeadroom(value, DEFAULT_EXTENDED_HEADROOM)).toBeCloseTo(value, 12);
    }
    const two = extendedLinearHeadroom(2, DEFAULT_EXTENDED_HEADROOM);
    expect(two).toBeGreaterThan(1);
    expect(two).toBeLessThan(2);
    expect(extendedLinearHeadroom(1, DEFAULT_EXTENDED_HEADROOM))
      .toBeCloseTo(extendedLinearHeadroom(1 + 1e-9, DEFAULT_EXTENDED_HEADROOM), 6);
    expect(extendedLinearHeadroom(1e9, DEFAULT_EXTENDED_HEADROOM)).toBeLessThanOrEqual(DEFAULT_EXTENDED_HEADROOM);
    expect(extendedLinearHeadroom(-1, DEFAULT_EXTENDED_HEADROOM)).toBe(0);
  });
});

describe("I-C21 策略编码与 uniform 打包", () => {
  it("hdrEncodeChannel:pq 按参考白换算并钳峰;hlg 相对域;SDR 策略无 HDR 编码(显式拒绝)", () => {
    const pq = { mode: "hdr" as const, strategy: "pq-2020" as const, failClosed: false, reason: "hdr-active" as const, pqPeakNits: 1000 };
    expect(pqToLinearNits(hdrEncodeChannel(1, pq, HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM)))
      .toBeCloseTo(HDR_REFERENCE_WHITE_NITS, 2);
    // 8.0 线性 × 203 nits = 1624 > 峰值 1000:钳峰。
    expect(pqToLinearNits(hdrEncodeChannel(8, pq, HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM)))
      .toBeCloseTo(1000, 2);
    const hlg = { mode: "hdr" as const, strategy: "hlg-2020" as const, failClosed: false, reason: "hdr-active" as const };
    expect(hdrEncodeChannel(0.5, hlg, HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM))
      .toBeCloseTo(linearToHlg(0.5), 12);
    expect(() => hdrEncodeChannel(0.5, { mode: "sdr", strategy: "aces-sdr", failClosed: false, reason: "opt-out" },
      HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM)).toThrow(/no HDR encode/);
  });

  it("hdrSettingsUniform:16B 四 float,策略索引与 WGSL 分支阈值同源(0/1/2)", () => {
    expect(hdrSettingsUniform({ mode: "hdr", strategy: "extended-linear", failClosed: false, reason: "hdr-active" },
      HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM))
      .toEqual(Float32Array.of(0, HDR_REFERENCE_WHITE_NITS, 0, DEFAULT_EXTENDED_HEADROOM));
    expect(hdrSettingsUniform({ mode: "hdr", strategy: "pq-2020", failClosed: false, reason: "hdr-active", pqPeakNits: 1600 },
      HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM))
      .toEqual(Float32Array.of(1, HDR_REFERENCE_WHITE_NITS, 1600, DEFAULT_EXTENDED_HEADROOM));
    expect(hdrSettingsUniform({ mode: "hdr", strategy: "hlg-2020", failClosed: false, reason: "hdr-active" },
      HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM))
      .toEqual(Float32Array.of(2, HDR_REFERENCE_WHITE_NITS, 0, DEFAULT_EXTENDED_HEADROOM));
    expect(() => hdrSettingsUniform({ mode: "sdr", strategy: "aces-sdr", failClosed: true, reason: "opt-out" },
      HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM)).toThrow(/active HDR policy/);
  });
});

describe("I-C21 白炉守恒边界(HDR 编码零能量放大)", () => {
  it("0.5 线性白炉:extended 恒等;PQ 往返回到 0.5×参考白;不超白炉辐射", () => {
    const furnace = 0.5;
    expect(extendedLinearHeadroom(furnace, DEFAULT_EXTENDED_HEADROOM)).toBeCloseTo(0.5, 12);
    const pqCode = linearNitsToPq(furnace * HDR_REFERENCE_WHITE_NITS);
    expect(pqToLinearNits(pqCode)).toBeCloseTo(furnace * HDR_REFERENCE_WHITE_NITS, 2);
    expect(pqToLinearNits(pqCode) / HDR_REFERENCE_WHITE_NITS).toBeLessThanOrEqual(furnace + 1e-6);
    expect(linearToHlg(furnace)).toBeLessThanOrEqual(1);
  });
});

describe("I-C21 HDR vs SDR 量化对照(合成数据)", () => {
  /** 64×64 亮度斜坡:1/4 像素落在 SDR 参考白之上,且高光带暖色度(色度保留可测)。 */
  const CHROMA_LUMA_SCALE = 0.2126 * 1.2 + 0.7152 + 0.0722 * 0.8;
  const ramp = new Float32Array(64 * 64 * 3);
  for (let pixel = 0; pixel < 64 * 64; pixel += 1) {
    const value = 0.1 + 7.9 * (pixel / (64 * 64 - 1));
    ramp[pixel * 3] = value * 1.2; ramp[pixel * 3 + 1] = value; ramp[pixel * 3 + 2] = value * 0.8;
  }
  const options = { referenceWhiteNits: HDR_REFERENCE_WHITE_NITS, pqPeakNits: DEFAULT_PQ_PEAK_NITS,
    extendedHeadroom: DEFAULT_EXTENDED_HEADROOM };

  it("亮度对照:SDR 峰值钉在参考白,HDR PQ 峰值达钳峰,headroom 损失比例 = 超白占比", () => {
    const metrics = quantifyHdrVsSdr(ramp, options);
    expect(metrics.pixels).toBe(64 * 64);
    expect(metrics.linear.peak).toBeCloseTo(8.0 * CHROMA_LUMA_SCALE, 3);
    expect(metrics.sdr.peakNits).toBe(HDR_REFERENCE_WHITE_NITS);
    expect(metrics.hdr.pqPeakNits).toBe(DEFAULT_PQ_PEAK_NITS);
    expect(metrics.hdr.pqPeakNits).toBeGreaterThan(metrics.sdr.peakNits);
    expect(metrics.hdr.extendedLinearPeakNits).toBeGreaterThan(metrics.sdr.peakNits);
    expect(metrics.hdr.extendedLinearPeakNits)
      .toBeLessThanOrEqual(DEFAULT_EXTENDED_HEADROOM * 1.2 * HDR_REFERENCE_WHITE_NITS + 1e-6);
    expect(metrics.linear.overSdrWhiteRatio).toBeCloseTo(metrics.sdr.headroomLossRatio, 12);
    expect(metrics.linear.overSdrWhiteRatio).toBeGreaterThan(0.2);
    expect(metrics.hdr.pqMeanNits).toBeGreaterThan(0);
    expect(metrics.hdr.hlgPeakSignal).toBeLessThanOrEqual(1);
  });

  it("色度对照:高光色度保留 ≥1(ACES 高光去饱和被量化),sRGB 域数据 100% 落 P3/Rec.2020", () => {
    const metrics = quantifyHdrVsSdr(ramp, options);
    expect(metrics.highlightChromaRetentionRatio).toBeGreaterThanOrEqual(1);
    expect(metrics.sdr.p3Coverage).toBeCloseTo(1, 12);
    expect(metrics.sdr.rec2020Coverage).toBeCloseTo(1, 12);
  });

  it("三角包含与色度换算自证:原色点在各自三角形内,sRGB 红原色 xy 落 BT.709 标注点", () => {
    const p3 = GAMUT_PRIMARIES.displayP3;
    expect(pointInTriangle(p3.red[0]!, p3.red[1]!, p3.red, p3.green, p3.blue)).toBe(true);
    expect(pointInTriangle(p3.white[0]!, p3.white[1]!, p3.red, p3.green, p3.blue)).toBe(true);
    const [rx, ry] = cieXyFromLinearSrgb(1, 0, 0);
    expect(rx).toBeCloseTo(GAMUT_PRIMARIES.srgb.red[0]!, 4);
    expect(ry).toBeCloseTo(GAMUT_PRIMARIES.srgb.red[1]!, 4);
  });

  it("非法输入显式抛错", () => {
    expect(() => quantifyHdrVsSdr(new Float32Array(4), options)).toThrow(/triplets/);
    expect(() => quantifyHdrVsSdr(ramp, { ...options, pqPeakNits: 0 })).toThrow(/positive/);
  });
});
