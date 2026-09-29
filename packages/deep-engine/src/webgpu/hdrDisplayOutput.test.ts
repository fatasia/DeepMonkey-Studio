import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTENDED_HEADROOM, DEFAULT_PQ_PEAK_NITS, describeHdrCanvasConfiguration,
  HDR_DISPLAY_REASON_CODES, HDR_DISPLAY_REASON_PAIRS, HDR_DISPLAY_STRATEGIES,
  HDR_REFERENCE_WHITE_NITS, GPU_TEXTURE_USAGE_SURFACE, MAX_PQ_PEAK_NITS,
  resolveHdrDisplayPolicy, type HdrDisplayProbe,
} from "./hdrDisplayOutput.js";

/** 全能力齐备的探测结果(HDR 真机/支持浏览器形态)。 */
const FULL_PROBE: HdrDisplayProbe = Object.freeze({
  webgpuAvailable: true, displayDynamicRange: "high",
  canvasToneMappingExtended: true, canvasFormatRgba16float: true,
});

describe("I-C21 HDR 显示策略门 —— 默认关(opt-out 显式码)", () => {
  it("不请求/请求关:一律 SDR + opt-out,且 failClosed=false(是默认而非失败)", () => {
    for (const request of [undefined, {}, { enabled: false }, { enabled: false, strategy: "pq-2020" as const }]) {
      const policy = resolveHdrDisplayPolicy(FULL_PROBE, request);
      expect(policy.mode).toBe("sdr");
      expect(policy.strategy).toBe("aces-sdr");
      expect(policy.reason).toBe("opt-out");
      expect(policy.failClosed).toBe(false);
    }
    // 无探测输入 + 未 opt-in 同样是默认关,不碰探测。
    expect(resolveHdrDisplayPolicy(undefined).reason).toBe("opt-out");
  });

  it("请求对象非法(数组/标量):按未 opt-in 处理(opt-out,非失败)", () => {
    for (const garbage of [[1], "hdr", 42] as unknown as HdrDisplayRequest[]) {
      const policy = resolveHdrDisplayPolicy(FULL_PROBE, garbage);
      expect(policy.mode).toBe("sdr");
      expect(policy.reason).toBe("opt-out");
      expect(policy.failClosed).toBe(false);
    }
  });

  it("默认策略解析被 self-check 消费:sdr/aces-sdr 词汇与封闭集一致", () => {
    expect((HDR_DISPLAY_STRATEGIES as readonly string[])).toContain("aces-sdr");
    expect(resolveHdrDisplayPolicy(undefined, {}).strategy).toBe("aces-sdr");
  });
});

describe("I-C21 HDR 显示策略门 —— 检测→策略匹配", () => {
  it("全能力齐备 + 自动策略:extended-linear(canvas 合成器映射同族)", () => {
    const policy = resolveHdrDisplayPolicy(FULL_PROBE, { enabled: true });
    expect(policy).toMatchObject({ mode: "hdr", strategy: "extended-linear", failClosed: false, reason: "hdr-active" });
    expect(policy.pqPeakNits).toBeUndefined();
  });

  it("显示器 HDR 但 canvas extended 不支持:自动策略回 pq-2020(直出 PQ 缓冲)", () => {
    const policy = resolveHdrDisplayPolicy(
      { ...FULL_PROBE, canvasToneMappingExtended: false }, { enabled: true });
    expect(policy).toMatchObject({ mode: "hdr", strategy: "pq-2020", reason: "hdr-active" });
    expect(policy.pqPeakNits).toBe(DEFAULT_PQ_PEAK_NITS);
  });

  it("显式策略生效;pq 峰值显式合法值直达、非法值钳制进合法域", () => {
    expect(resolveHdrDisplayPolicy(FULL_PROBE, { enabled: true, strategy: "hlg-2020" }).strategy).toBe("hlg-2020");
    const peak = resolveHdrDisplayPolicy(FULL_PROBE, { enabled: true, strategy: "pq-2020", pqPeakNits: 1600 });
    expect(peak.pqPeakNits).toBe(1600);
    const overflow = resolveHdrDisplayPolicy(FULL_PROBE, { enabled: true, strategy: "pq-2020", pqPeakNits: 99999 });
    expect(overflow.pqPeakNits).toBe(MAX_PQ_PEAK_NITS);
    const nan = resolveHdrDisplayPolicy(FULL_PROBE, { enabled: true, strategy: "pq-2020", pqPeakNits: Number.NaN });
    expect(nan.pqPeakNits).toBe(DEFAULT_PQ_PEAK_NITS);
  });
});

describe("I-C21 HDR 显示策略门 —— fail-closed 逐原因", () => {
  const cases: ReadonlyArray<[string, HdrDisplayProbe | undefined, HdrDisplayRequest, string]> = [
    ["探测对象缺失", undefined, { enabled: true }, "invalid-probe"],
    ["探测对象非对象", [1] as unknown as HdrDisplayProbe, { enabled: true }, "invalid-probe"],
    ["字段非法", { ...FULL_PROBE, displayDynamicRange: "high" } as HdrDisplayProbe,
      { enabled: true, strategy: "hdr9" as never }, "invalid-probe"],
    ["WebGPU 缺席", { ...FULL_PROBE, webgpuAvailable: false }, { enabled: true }, "webgpu-missing"],
    ["显示器 SDR", { ...FULL_PROBE, displayDynamicRange: "standard" }, { enabled: true }, "display-not-hdr"],
    ["显示器动态范围未知(保守不放行)", { ...FULL_PROBE, displayDynamicRange: "unknown" },
      { enabled: true }, "display-not-hdr"],
    ["canvas 拒收 rgba16float", { ...FULL_PROBE, canvasFormatRgba16float: false },
      { enabled: true }, "hdr-canvas-format-unsupported"],
    ["显式 extended-linear 但 canvas extended 不支持",
      { ...FULL_PROBE, canvasToneMappingExtended: false },
      { enabled: true, strategy: "extended-linear" }, "canvas-extended-tonemapping-unsupported"],
  ];
  for (const [name, probe, request, reason] of cases) {
    it(`${name} → sdr/${reason}`, () => {
      const policy = resolveHdrDisplayPolicy(probe, request);
      expect(policy.mode).toBe("sdr");
      expect(policy.strategy).toBe("aces-sdr");
      expect(policy.failClosed).toBe(true);
      expect(policy.reason).toBe(reason);
    });
  }
});

describe("I-C21 HDR canvas 配置描述符", () => {
  it("HDR 策略 → rgba16float + extended/standard + surface usage;SDR/缺省 → null(零介入)", () => {
    const extended = describeHdrCanvasConfiguration(
      resolveHdrDisplayPolicy(FULL_PROBE, { enabled: true }));
    expect(extended).toEqual({ format: "rgba16float", toneMappingMode: "extended", usage: GPU_TEXTURE_USAGE_SURFACE });
    expect(GPU_TEXTURE_USAGE_SURFACE).toBe(16 | 1); // RENDER_ATTACHMENT|COPY_SRC;COPY_SRC≠8(STORAGE_BINDING)
    const pq = describeHdrCanvasConfiguration(
      resolveHdrDisplayPolicy({ ...FULL_PROBE, canvasToneMappingExtended: false }, { enabled: true }));
    expect(pq?.toneMappingMode).toBe("standard");
    expect(describeHdrCanvasConfiguration(resolveHdrDisplayPolicy(undefined))).toBeNull();
    expect(describeHdrCanvasConfiguration(undefined)).toBeNull();
  });
});

describe("I-C21 词汇封闭与配对(加载期自检的存在前提)", () => {
  it("策略/原因码封闭集完整且 hdr-active 只属于 hdr 档", () => {
    expect([...HDR_DISPLAY_STRATEGIES]).toEqual(["extended-linear", "pq-2020", "hlg-2020", "aces-sdr"]);
    expect([...HDR_DISPLAY_REASON_CODES]).toContain("hdr-active");
    expect(HDR_DISPLAY_REASON_PAIRS.hdr).toEqual(["hdr-active"]);
    expect(HDR_DISPLAY_REASON_PAIRS.sdr).not.toContain("hdr-active");
    for (const codes of [HDR_DISPLAY_REASON_PAIRS.hdr, HDR_DISPLAY_REASON_PAIRS.sdr]) {
      for (const code of codes) expect(HDR_DISPLAY_REASON_CODES).toContain(code);
    }
  });

  it("锚点常量在规范域", () => {
    expect(HDR_REFERENCE_WHITE_NITS).toBe(203);
    expect(DEFAULT_PQ_PEAK_NITS).toBe(1000);
    expect(MAX_PQ_PEAK_NITS).toBe(10000);
    expect(DEFAULT_EXTENDED_HEADROOM).toBeGreaterThan(1);
  });
});
