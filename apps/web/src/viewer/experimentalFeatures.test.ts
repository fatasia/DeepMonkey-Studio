import { afterEach, describe, expect, it } from "vitest";
import {
  b4HlodClusterEnabled,
  debugFullRenderEnabled,
  f3VirtualTexturesEnabled,
  f4TemporalUpscaleEnabled,
  g1ClusterLodEnabled,
  megaLightsEnabled,
  rayTracedShadowsEnabled,
  sdfGiEnabled,
  t07DynamicResolutionPolicy,
  t11PipelineBootstrap,
  t25GpuPassTimingEnabled,
} from "./studioDeepWebGpuBridgeFeatureToggles";
import {
  EXPERIMENTAL_FEATURES,
  buildExperimentalFeatureHref,
  experimentalFeatureDetail,
  experimentalFeatureLabel,
  isExperimentalFeatureEnabled,
  readExperimentalFeatureStates,
} from "./experimentalFeatures";

/**
 * 注册表与桥侧 toggle 函数的对拍测试:每个 URL 参数的生效判定必须逐字一致,
 * 防止"面板显示开、引擎实际关"的合同漂移(同族条款)。
 */

const originalLocation = globalThis.location;

function setSearch(href: string, search: string): void {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href, search },
  });
}

afterEach(() => {
  if (originalLocation === undefined) delete (globalThis as { location?: Location }).location;
  else Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
});

/** 与 StudioDeepWebGpuBridge.test.ts 同源:只测 1/true/on 三种真值与其余假值。 */
const TRUTH_MATRIX = ["", "?x=1", "=1", "=true", "=on", "=0", "=false", "=off", "=yes", "=TRUE", "=On"] as const;

describe("experimental feature registry", () => {
  it("注册表覆盖全部 12 个 URL 开关,无重复参数", () => {
    expect(EXPERIMENTAL_FEATURES).toHaveLength(12);
    expect(new Set(EXPERIMENTAL_FEATURES.map((spec) => spec.param)).size).toBe(12);
    const known = new Set([
      "t07-dynamic-resolution", "f4-temporal-upscale", "f3-virtual-textures", "b4-hlod-cluster",
      "g1-cluster-lod", "mega-lights", "ray-traced-shadows", "sdf-gi", "t25-gpu-pass-timing",
      "debug-full-render", "t11-critical-pipelines", "t11-defer-deformation",
    ]);
    for (const spec of EXPERIMENTAL_FEATURES) expect(known.has(spec.param)).toBe(true);
  });

  it("对拍:每个 opt-in 注册项与桥侧 toggle 函数在真值矩阵上逐值一致", () => {
    const optIn = new Map<string, () => boolean>([
      ["t07-dynamic-resolution", () => t07DynamicResolutionPolicy() !== undefined],
      ["b4-hlod-cluster", b4HlodClusterEnabled],
      ["g1-cluster-lod", g1ClusterLodEnabled],
      ["t25-gpu-pass-timing", t25GpuPassTimingEnabled],
      ["f4-temporal-upscale", f4TemporalUpscaleEnabled],
      ["debug-full-render", debugFullRenderEnabled],
      ["mega-lights", megaLightsEnabled],
      ["ray-traced-shadows", rayTracedShadowsEnabled],
      ["f3-virtual-textures", f3VirtualTexturesEnabled],
      ["sdf-gi", sdfGiEnabled],
    ]);
    for (const spec of EXPERIMENTAL_FEATURES.filter((item) => item.kind === "opt-in")) {
      const bridge = optIn.get(spec.param);
      expect(bridge, `注册项 ${spec.param} 必须有对拍目标`).toBeDefined();
      for (const suffix of TRUTH_MATRIX) {
        const search = `${spec.param}${suffix}`;
        setSearch(`http://localhost/?${search}`, `?${search}`);
        expect(isExperimentalFeatureEnabled(spec, `?${search}`), `${spec.param}${suffix}`)
          .toBe(bridge!());
      }
    }
  });

  it("对拍:t25-gpu-pass-timing 与 f4 依赖说明与注册表一致", () => {
    const t25 = EXPERIMENTAL_FEATURES.find((spec) => spec.param === "t25-gpu-pass-timing")!;
    const f4 = EXPERIMENTAL_FEATURES.find((spec) => spec.param === "f4-temporal-upscale")!;
    expect(f4.requires?.param).toBe("t07-dynamic-resolution");
    setSearch("http://localhost/?t25-gpu-pass-timing=1", "?t25-gpu-pass-timing=1");
    expect(isExperimentalFeatureEnabled(t25, "?t25-gpu-pass-timing=1")).toBe(true);
    setSearch("http://localhost/", "");
    expect(isExperimentalFeatureEnabled(t25, "")).toBe(false);
  });

  it("对拍:opt-out 首帧开关默认开,0/false/off 显式关闭", () => {
    const critical = EXPERIMENTAL_FEATURES.find((spec) => spec.param === "t11-critical-pipelines")!;
    const defer = EXPERIMENTAL_FEATURES.find((spec) => spec.param === "t11-defer-deformation")!;
    expect(critical.kind).toBe("opt-out");
    expect(defer.kind).toBe("opt-out");
    for (const suffix of TRUTH_MATRIX) {
      const search = `?t11-critical-pipelines${suffix}&t11-defer-deformation${suffix}`;
      setSearch(`http://localhost/${search}`, search);
      const bootstrap = t11PipelineBootstrap(true)!;
      expect(isExperimentalFeatureEnabled(critical, search), suffix).toBe(bootstrap.firstFrameSubset);
      expect(isExperimentalFeatureEnabled(defer, search), suffix).toBe(bootstrap.deferDeformation);
    }
  });

  it("readExperimentalFeatureStates 一次读全量,键为参数名", () => {
    setSearch("http://localhost/?mega-lights=1&sdf-gi=0", "?mega-lights=1&sdf-gi=0");
    const states = readExperimentalFeatureStates("?mega-lights=1&sdf-gi=0");
    expect(states["mega-lights"]).toBe(true);
    expect(states["sdf-gi"]).toBe(false);
    expect(states["t07-dynamic-resolution"]).toBe(false); // opt-in 缺省 = 关
    expect(states["t11-critical-pipelines"]).toBe(true); // opt-out 缺省 = 开
    expect(Object.keys(states)).toHaveLength(12);
  });

  it("buildExperimentalFeatureHref:opt-in 开写入 =1,关移除;opt-out 开(默认)移除,关写入 =1;其余参数保留", () => {
    const href = "http://localhost/studio/abc?project=p1&mega-lights=1&f4-temporal-upscale=1&t11-critical-pipelines=0";
    const out = buildExperimentalFeatureHref(href, {
      "mega-lights": true,
      "f4-temporal-upscale": false,
      "t11-critical-pipelines": false,
      "t25-gpu-pass-timing": true,
      "sdf-gi": false,
      "f3-virtual-textures": false,
      "b4-hlod-cluster": false,
      "g1-cluster-lod": false,
      "ray-traced-shadows": false,
      "debug-full-render": false,
      "t07-dynamic-resolution": false,
      "t11-defer-deformation": true,
    });
    const params = new URL(out).searchParams;
    expect(out.startsWith("http://localhost/studio/abc")).toBe(true);
    expect(params.get("project")).toBe("p1"); // 无关参数原样保留
    expect(params.get("mega-lights")).toBe("1"); // opt-in 开 → =1
    expect(params.has("f4-temporal-upscale")).toBe(false); // opt-in 关 → 移除
    expect(params.get("t25-gpu-pass-timing")).toBe("1"); // 新开 → =1
    expect(params.get("t11-critical-pipelines")).toBe("0"); // opt-out 显式关 → =0(桥侧只认 0/false/off)
    expect(params.has("t11-defer-deformation")).toBe(false); // opt-out 开(默认) → 移除
    for (const rest of ["sdf-gi", "f3-virtual-textures", "b4-hlod-cluster", "g1-cluster-lod", "ray-traced-shadows", "debug-full-render", "t07-dynamic-resolution"]) {
      expect(params.has(rest), rest).toBe(false);
    }
  });

  it("链接往返:build → read 状态与草稿一致", () => {
    const draft = readExperimentalFeatureStates("");
    draft["mega-lights"] = true;
    draft["t11-critical-pipelines"] = false;
    const href = buildExperimentalFeatureHref("http://localhost/studio/new", draft);
    const reread = readExperimentalFeatureStates(new URL(href).search);
    expect(reread).toEqual(draft);
  });

  it("双语:label/detail 按语言取对应槽位", () => {
    const spec = EXPERIMENTAL_FEATURES[0]!;
    expect(experimentalFeatureLabel(spec, "zh-CN")).toBe(spec.label[0]);
    expect(experimentalFeatureLabel(spec, "en-US")).toBe(spec.label[1]);
    expect(experimentalFeatureDetail(spec, "zh-CN")).toBe(spec.detail[0]);
    expect(experimentalFeatureDetail(spec, "en-US")).toBe(spec.detail[1]);
  });
});
