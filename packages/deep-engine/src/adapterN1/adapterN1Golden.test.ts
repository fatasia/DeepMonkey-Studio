/**
 * P1-23 N1 golden 对拍(TS 侧):四类认证 fixture 的 digest 黄金断言、
 * display delta 与 Native `adapter_n1_golden_tests.rs` 的期望输出逐字段一致,
 * 以及产物满足 TS 侧共享 Deep2d 合同(`validateDeep2dDisplayList`)。
 */

import { describe, expect, it } from "vitest";

import { DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, validateDeep2dDisplayList, type Deep2dCommand, type Deep2dResource } from "../deep2dDisplayList.js";
import { fixtureDigest } from "./canonicalJson.js";
import {
  adapterCertifiedFor, ANIMATION_DIGEST, ANIMATION_FIXTURE, certifiedAdapter, CHART_DIGEST, CHART_FIXTURE,
  encodeUtf8, PLATFORM, RICH_TEXT_DIGEST, RICH_TEXT_FIXTURE, SVG_DIGEST, SVG_FIXTURE,
} from "./adapterN1Fixtures.testUtils.js";
import type { N1Adapted } from "./types.js";

function adaptedOf(fixture: string): N1Adapted {
  const outcome = certifiedAdapter().adapt(encodeUtf8(fixture), PLATFORM, 0);
  if (outcome.state !== "adapted") throw new Error(`certified fixture must adapt: ${outcome.reason}`);
  return outcome.adapted;
}

describe("golden digests (canonical JSON + SHA-256, cross-language)", () => {
  it("recomputes the frozen certification digests of all four certified fixtures", () => {
    expect(fixtureDigest(encodeUtf8(SVG_FIXTURE))).toBe(SVG_DIGEST);
    expect(fixtureDigest(encodeUtf8(RICH_TEXT_FIXTURE))).toBe(RICH_TEXT_DIGEST);
    expect(fixtureDigest(encodeUtf8(CHART_FIXTURE))).toBe(CHART_DIGEST);
    expect(fixtureDigest(encodeUtf8(ANIMATION_FIXTURE))).toBe(ANIMATION_DIGEST);
  });

  it("digests are 64-char hex and pairwise distinct", () => {
    const digests = [SVG_DIGEST, RICH_TEXT_DIGEST, CHART_DIGEST, ANIMATION_DIGEST];
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([SVG_DIGEST, RICH_TEXT_DIGEST, CHART_DIGEST, ANIMATION_DIGEST]).size).toBe(4);
  });

  it("canonicalization is whitespace-insensitive: reformatted fixture keeps the same digest", () => {
    const reformatted = JSON.stringify(JSON.parse(ANIMATION_FIXTURE));
    expect(fixtureDigest(encodeUtf8(reformatted))).toBe(ANIMATION_DIGEST);
  });
});

function wrappedDisplayList(delta: { resources: readonly Deep2dResource[]; commands: readonly Deep2dCommand[] }) {
  return {
    schemaVersion: DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION,
    id: "n1.golden.wrap",
    revision: 0,
    logicalWidth: 800.0,
    logicalHeight: 600.0,
    scaleFactor: 1.0,
    resources: delta.resources,
    commands: delta.commands,
    atlases: [],
  };
}

describe("svg certified combination produces the golden delta", () => {
  it("resources and commands match the native golden output field by field", () => {
    const adapted = adaptedOf(SVG_FIXTURE);
    expect(adapted.kind).toBe("svg");
    expect(adapted.actions).toEqual([]);
    expect(adapted.delta.schemaVersion).toBe(1);
    expect(adapted.delta.resources).toEqual([
      {
        kind: "path", id: "n1.svg.icon.body", revision: 0,
        verbs: [
          { op: "move", x: 2, y: 12 }, { op: "line", x: 12, y: 2 }, { op: "line", x: 22, y: 12 },
          { op: "line", x: 12, y: 22 }, { op: "close" },
        ],
      },
      {
        kind: "path", id: "n1.svg.icon.stem", revision: 0,
        verbs: [{ op: "move", x: 12, y: 22 }, { op: "line", x: 12, y: 16 }, { op: "line", x: 16, y: 16 }],
      },
    ]);
    expect(adapted.delta.commands).toEqual([
      {
        kind: "path", id: "n1.svg.icon.body.paint", zOrder: 1, transform: [1, 0, 0, 1, 0, 0],
        pathId: "n1.svg.icon.body", fill: [0.1, 0.2, 0.3, 1], stroke: [1, 1, 1, 1], strokeWidth: 1.5,
        lineCap: "butt", lineJoin: "miter",
      },
      {
        kind: "path", id: "n1.svg.icon.stem.paint", zOrder: 2, transform: [1, 0, 0, 1, 0, 0],
        pathId: "n1.svg.icon.stem", stroke: [1, 0, 0, 1], strokeWidth: 1, lineCap: "butt", lineJoin: "miter",
      },
    ]);
  });

  it("delta satisfies the shared deep2d display-list contract", () => {
    const adapted = adaptedOf(SVG_FIXTURE);
    expect(validateDeep2dDisplayList(wrappedDisplayList(adapted.delta)).valid).toBe(true);
  });
});

describe("chart extension certified combination produces the golden delta", () => {
  it("trend line, band and marker map to the expected path verbs", () => {
    const adapted = adaptedOf(CHART_FIXTURE);
    expect(adapted.kind).toBe("chart-extension");
    expect(adapted.delta.resources.map((resource) => resource.kind)).toEqual(["path", "path", "path"]);
    const verbsOf = (index: number) => (adapted.delta.resources[index] as { verbs: readonly unknown[] }).verbs;
    expect(verbsOf(0)).toEqual([{ op: "move", x: 0, y: 10 }, { op: "line", x: 100, y: 20 }]);
    expect(verbsOf(1)).toEqual([
      { op: "move", x: 0, y: 8 }, { op: "line", x: 100, y: 8 }, { op: "line", x: 100, y: 12 },
      { op: "line", x: 0, y: 12 }, { op: "close" },
    ]);
    expect(verbsOf(2)).toHaveLength(6);
    expect((verbsOf(2) as readonly unknown[])[0]).toEqual({ op: "move", x: 54, y: 15 });
    expect((verbsOf(2) as readonly unknown[])[5]).toEqual({ op: "close" });
    expect(adapted.delta.commands[0]).toMatchObject({ id: "n1.chart.trend.paint", zOrder: 5, pathId: "n1.chart.trend", stroke: [0, 0.5, 1, 1], strokeWidth: 2 });
    expect(adapted.delta.commands[0]).not.toHaveProperty("fill");
    expect(adapted.delta.commands[1]).toMatchObject({ id: "n1.chart.band.paint", zOrder: 1, pathId: "n1.chart.band", fill: [1, 0, 0, 0.25] });
    expect(adapted.delta.commands[1]).not.toHaveProperty("stroke");
    expect(validateDeep2dDisplayList(wrappedDisplayList(adapted.delta)).valid).toBe(true);
  });
});

describe("rich text certified combination produces the golden delta", () => {
  it("paragraph slicing, font injection and inline objects match the native golden output", () => {
    const adapted = adaptedOf(RICH_TEXT_FIXTURE);
    expect(adapted.kind).toBe("rich-text-inline");
    expect(adapted.delta.resources).toEqual([
      { kind: "font", id: "n1.font.main", revision: 0, assetId: "asset.font-main", family: "Inter", weight: 400, style: "normal" },
      { kind: "image", id: "n1.rt.pump.icon", revision: 0, assetId: "asset.pump-icon", width: 16, height: 16, colorSpace: "srgb" },
    ]);
    const textOf = (index: number) => (adapted.delta.commands[index] as { text: string }).text;
    expect(adapted.delta.commands).toHaveLength(3);
    expect(textOf(0)).toBe("泵运行 ");
    expect(textOf(1)).toBe("abnormal");
    expect(adapted.delta.commands[0]).toMatchObject({
      id: "n1.rt.panel.text.0", fontId: "n1.font.main", fontSize: 14, color: [0.05, 0.05, 0.05, 1],
    });
    expect(adapted.delta.commands[2]).toMatchObject({
      id: "n1.rt.panel.inline.2", imageId: "n1.rt.pump.icon", hitId: "n1.rt.pump.icon", width: 16, height: 16,
    });
    expect(validateDeep2dDisplayList(wrappedDisplayList(adapted.delta)).valid).toBe(true);
  });
});

describe("animation certified combination samples keyframes at the injected time", () => {
  it("250ms holds rotor's first keyframe and lamp has stepped to index 1", () => {
    const outcome = certifiedAdapter().adapt(encodeUtf8(ANIMATION_FIXTURE), PLATFORM, 250);
    if (outcome.state !== "adapted") throw new Error(outcome.reason);
    expect(outcome.adapted.kind).toBe("animation-abi");
    expect(outcome.adapted.delta.resources).toEqual([]);
    expect(outcome.adapted.delta.commands).toEqual([]);
    expect(outcome.adapted.actions).toEqual([
      { kind: "set-property", nodeId: "pump.rotor", property: "rotation", value: { kind: "number", value: 0 } },
      { kind: "set-property", nodeId: "pump.lamp", property: "opacity", value: { kind: "index", value: 1 } },
    ]);
  });

  it("600ms samples rotor 90 and lamp index 2; sampling is a pure function of the injected time", () => {
    const adapter = certifiedAdapter();
    const at = (elapsedMs: number) => adapter.adapt(encodeUtf8(ANIMATION_FIXTURE), PLATFORM, elapsedMs);
    const at600 = at(600);
    if (at600.state !== "adapted") throw new Error(at600.reason);
    expect(at600.adapted.actions).toEqual([
      { kind: "set-property", nodeId: "pump.rotor", property: "rotation", value: { kind: "number", value: 90 } },
      { kind: "set-property", nodeId: "pump.lamp", property: "opacity", value: { kind: "index", value: 2 } },
    ]);
    expect(at(250)).toEqual(at(250));
  });

  it("digest mismatch is detected before adaptation", () => {
    const tampered = adapterCertifiedFor(SVG_FIXTURE, "svg", "0".repeat(64));
    const outcome = tampered.adapt(encodeUtf8(SVG_FIXTURE), PLATFORM, 0);
    expect(outcome).toMatchObject({ state: "blocked" });
    if (outcome.state === "blocked") expect(outcome.reason).toContain("digest mismatch");
  });
});
