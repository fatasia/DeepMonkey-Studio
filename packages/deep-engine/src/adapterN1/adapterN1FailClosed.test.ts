/**
 * P1-23 N1 fail-closed 拒绝矩阵(TS 侧):与 Native `adapter_n1_tests.rs`
 * 同一家族——缺失/非法输入、unknown 与 blocked 分层、未认证组合、摘要不符、
 * 预算触界、重复资源 id、UTF-16 预算、宿主资产形状,全部拒绝且带显式原因。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createN1Adapter } from "./adapter.js";
import { fixtureDigest } from "./canonicalJson.js";
import {
  adapterCertifiedFor, ANIMATION_FIXTURE, certifiedAdapter, encodeUtf8, hostAssets, PLATFORM,
  RICH_TEXT_DIGEST, RICH_TEXT_FIXTURE, SVG_DIGEST, SVG_FIXTURE,
} from "./adapterN1Fixtures.testUtils.js";
import { DEFAULT_N1_BUDGET } from "./types.js";

const reasonOf = (outcome: { state: string; reason?: string }): string => {
  expect(outcome.state).not.toBe("adapted");
  return outcome.reason ?? "";
};

describe("fail-closed matrix: blocks and unknowns carry reasons", () => {
  const adapter = certifiedAdapter();

  it("missing fixture (null / undefined / empty bytes) blocks", () => {
    for (const fixture of [null, undefined, new Uint8Array(0)]) {
      expect(reasonOf(adapter.adapt(fixture, PLATFORM, 0))).toContain("missing fixture");
    }
  });

  it("invalid JSON blocks", () => {
    expect(reasonOf(adapter.adapt(encodeUtf8("{oops"), PLATFORM, 0))).toContain("not valid JSON");
  });

  it("unknown kind / missing discriminator → unknown, never guessed", () => {
    const unknownKind = adapter.adapt(encodeUtf8('{"kind":"lottie","schemaVersion":1,"input":{}}'), PLATFORM, 0);
    expect(unknownKind.state).toBe("unknown");
    if (unknownKind.state === "unknown") expect(unknownKind.reason).toContain("unknown input kind 'lottie'");
    const noDiscriminator = adapter.adapt(encodeUtf8('{"schemaVersion":1}'), PLATFORM, 0);
    expect(noDiscriminator.state).toBe("unknown");
    if (noDiscriminator.state === "unknown") expect(noDiscriminator.reason).toContain("no 'kind' discriminator");
  });

  it("unknown schema version → unknown, certification ledger is not consulted first", () => {
    const unknownVersion = adapter.adapt(
      encodeUtf8('{"kind":"svg","schemaVersion":2,"input":{"id":"x","viewBox":[0,0,1,1],"paths":[]}}'),
      PLATFORM, 0,
    );
    expect(unknownVersion.state).toBe("unknown");
    if (unknownVersion.state === "unknown") {
      expect(unknownVersion.reason).toContain("unsupported schema version 2 for kind 'svg'");
    }
  });

  it("nonconforming payload / missing input block after a matching digest", () => {
    const nonconforming = '{"kind":"svg","schemaVersion":1,"input":{"id":"x","extra":true}}';
    const reason = reasonOf(adapterCertifiedFor(nonconforming, "svg").adapt(encodeUtf8(nonconforming), PLATFORM, 0));
    expect(reason).toContain("does not conform to its declared schema");
    const emptyPayload = '{"kind":"svg","schemaVersion":1}';
    const reason2 = reasonOf(adapterCertifiedFor(emptyPayload, "svg").adapt(encodeUtf8(emptyPayload), PLATFORM, 0));
    expect(reason2).toContain("no 'input' payload");
  });

  it("uncertified platform combination blocks", () => {
    expect(reasonOf(adapter.adapt(encodeUtf8(SVG_FIXTURE), "mac-metal", 0))).toContain("is not certified");
  });

  it("digest mismatch blocks when the certified digest does not match the bytes", () => {
    const tampered = adapterCertifiedFor(SVG_FIXTURE, "svg", "0".repeat(64));
    const outcome = tampered.adapt(encodeUtf8(SVG_FIXTURE), PLATFORM, 0);
    expect(outcome.state).toBe("blocked");
    if (outcome.state === "blocked") expect(outcome.reason).toContain("digest mismatch");
  });
});

describe("duplicate resource ids block before merge", () => {
  it("duplicate svg path ids block", () => {
    const duplicateSvg = `{"kind":"svg","schemaVersion":1,"input":{"id":"n1.svg.dup","viewBox":[0,0,10,10],"paths":[
      {"id":"n1.svg.dup.a","data":"M 0 0 L 1 1","zOrder":0,"stroke":[1,1,1,1],"strokeWidth":1},
      {"id":"n1.svg.dup.a","data":"M 1 1 L 2 2","zOrder":0,"stroke":[1,1,1,1],"strokeWidth":1}]}}`;
    const reason = reasonOf(adapterCertifiedFor(duplicateSvg, "svg").adapt(encodeUtf8(duplicateSvg), PLATFORM, 0));
    expect(reason).toContain("duplicate svg path id");
  });

  it("duplicate chart overlay ids block", () => {
    const duplicateChart = `{"kind":"chart-extension","schemaVersion":1,"input":{"id":"n1.chart.dup","overlays":[
      {"overlay":"marker","id":"n1.chart.dup.m","center":[1,1],"radius":1,"fill":[0,0,0,1],"zOrder":0},
      {"overlay":"marker","id":"n1.chart.dup.m","center":[2,2],"radius":1,"fill":[0,0,0,1],"zOrder":0}]}}`;
    const reason = reasonOf(adapterCertifiedFor(duplicateChart, "chart-extension").adapt(encodeUtf8(duplicateChart), PLATFORM, 0));
    expect(reason).toContain("duplicate chart overlay id");
  });

  it("degenerate threshold bands and unsupported path commands block with explicit reasons", () => {
    const degenerate = '{"kind":"chart-extension","schemaVersion":1,"input":{"id":"n1.chart.deg","overlays":[' +
      '{"overlay":"threshold-band","id":"b","x0":10,"y0":0,"x1":0,"y1":5,"fill":[0,0,0,1],"zOrder":0}]}}';
    expect(reasonOf(adapterCertifiedFor(degenerate, "chart-extension").adapt(encodeUtf8(degenerate), PLATFORM, 0)))
      .toContain("degenerate");
    const curved = '{"kind":"svg","schemaVersion":1,"input":{"id":"n1.svg.curve","viewBox":[0,0,10,10],"paths":[' +
      '{"id":"p","data":"M 0 0 C 1 1 2 2 3 3","zOrder":0,"stroke":[1,1,1,1],"strokeWidth":1}]}}';
    const reason = reasonOf(adapterCertifiedFor(curved, "svg").adapt(encodeUtf8(curved), PLATFORM, 0));
    expect(reason).toContain("rejected: unsupported svg path command 'C'");
  });
});

describe("budgets block instead of truncating", () => {
  it("svg path budget exceeded is distinguishable from byte budget", () => {
    const pathBudget = certifiedAdapter({ ...DEFAULT_N1_BUDGET, maxPaths: 1 });
    expect(reasonOf(pathBudget.adapt(encodeUtf8(SVG_FIXTURE), PLATFORM, 0)))
      .toContain("svg path budget exceeded: 2 paths > max 1");
    const bytesBudget = certifiedAdapter({ ...DEFAULT_N1_BUDGET, maxFixtureBytes: 16 });
    expect(reasonOf(bytesBudget.adapt(encodeUtf8(SVG_FIXTURE), PLATFORM, 0))).toContain("byte budget");
  });

  it("rich text budget counts UTF-16 code units so astral characters are not under-counted", () => {
    const fixture = '{"kind":"rich-text-inline","schemaVersion":1,"input":{"id":"n1.rt.utf16","text":"😀",'
      + '"styles":[],"paragraphs":[],"inlineObjects":[]}}';
    const budgetAdapter = createN1Adapter(
      { lookup: (kind, schemaVersion, platform) => kind === "rich-text-inline" && schemaVersion === 1 && platform === PLATFORM ? { kind, schemaVersion, platform, fixtureDigest: fixtureDigest(encodeUtf8(fixture))! } : undefined },
      { ...DEFAULT_N1_BUDGET, maxTextCodeUnits: 1 },
      hostAssets(),
    );
    if (!budgetAdapter.ok) throw new Error(budgetAdapter.reason);
    const reason = reasonOf(budgetAdapter.adapter.adapt(encodeUtf8(fixture), PLATFORM, 0));
    expect(reason).toContain("rich text code-unit budget exceeded: 2 > max 1");
  });

  it("rich text without the host inline asset blocks instead of guessing", () => {
    const assets = hostAssets({});
    const result = createN1Adapter(
      { lookup: (kind, schemaVersion, platform) => kind === "rich-text-inline" && schemaVersion === 1 && platform === PLATFORM ? { kind, schemaVersion, platform, fixtureDigest: RICH_TEXT_DIGEST } : undefined },
      DEFAULT_N1_BUDGET, assets,
    );
    if (!result.ok) throw new Error(result.reason);
    const reason = reasonOf(result.adapter.adapt(encodeUtf8(RICH_TEXT_FIXTURE), PLATFORM, 0));
    expect(reason).toContain("no host-injected asset");
  });
});

describe("host asset shapes are validated at construction", () => {
  const build = (mutate: (assets: ReturnType<typeof hostAssets>) => unknown) => {
    const assets = hostAssets();
    mutate(assets);
    return createN1Adapter({ lookup: () => undefined }, DEFAULT_N1_BUDGET, assets);
  };
  const blankAsset = { assetId: " ", width: 1, height: 1 };

  it("blank font fields, bad weight, bad color and bad size are rejected", () => {
    // 报文与 Native 同源(label 前缀拼接导致 "font font id" 双写是两边一致的)。
    expect(build((assets) => { (assets.font as { id: string }).id = " "; }).reason).toContain("font id must be non-blank");
    expect(build((assets) => { (assets.font as { family: string }).family = ""; }).reason).toContain("font family must be non-blank");
    expect(build((assets) => { (assets.font as { weight: number }).weight = 450; }).reason).toContain("weight must be 100..900");
    expect(build((assets) => { (assets.font as { color: number[] }).color = [0, 0, 0, 2]; }).reason).toContain("host font color");
    expect(build((assets) => { (assets.font as { fontSize: number }).fontSize = 0; }).reason).toContain("host font size");
  });

  it("inline asset identities must be non-blank with 1..=65536 dimensions", () => {
    expect(build((assets) => { assets.inlineAssets.set("x", blankAsset); }).reason).toContain("blank asset id");
    expect(build((assets) => { assets.inlineAssets.set("x", { assetId: "a", width: 0, height: 1 }); }).reason).toContain("dimensions");
    expect(build((assets) => { assets.inlineAssets.set("x", { assetId: "a", width: 1, height: 65_537 }); }).reason).toContain("dimensions");
  });

  it("animation fixtures adapt through the certified adapter too (family coverage)", () => {
    const outcome = certifiedAdapter().adapt(encodeUtf8(ANIMATION_FIXTURE), PLATFORM, 0);
    expect(outcome.state).toBe("adapted");
  });
});

describe("grapheme segmentation is fail-closed when the runtime lacks Intl.Segmenter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rich text blocks with an explicit reason instead of approximating clusters", () => {
    vi.stubGlobal("Intl", {});
    const adapter = certifiedAdapter();
    const outcome = adapter.adapt(encodeUtf8(RICH_TEXT_FIXTURE), PLATFORM, 0);
    expect(outcome.state).toBe("blocked");
    if (outcome.state === "blocked") expect(outcome.reason).toContain("grapheme segmentation is unavailable");
  });
});

describe("adapter purity", () => {
  it("the same fixture always yields the identical outcome", () => {
    const adapter = certifiedAdapter();
    expect(adapter.adapt(encodeUtf8(SVG_FIXTURE), PLATFORM, 0)).toEqual(adapter.adapt(encodeUtf8(SVG_FIXTURE), PLATFORM, 0));
  });
});

describe("ledger digest sanity", () => {
  it("fixtures digest to the frozen ledger entries", () => {
    expect(fixtureDigest(encodeUtf8(SVG_FIXTURE))).toBe(SVG_DIGEST);
    expect(fixtureDigest(encodeUtf8(RICH_TEXT_FIXTURE))).toBe(RICH_TEXT_DIGEST);
  });
});
