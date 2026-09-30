// J3-D-full 逐层矩阵聚合器负例/合同测试:错层、错门、证据过期、失败/不稳定、历史冒充 fresh、差异登记。
// 全部 CPU 合成数据,不依赖 test-output 现存文件与 GPU。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { REQUIRED_LAYER_GATES, LEGAL_DIFFERENCE_MATRIX_V1, registerLegalDifference,
  validateLayerEvidence, aggregateLayerMatrix } from "./j3DFullLayerMatrix.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

const SCOPES = {
  "geometry-coverage": ["production-geometry-depth-interior"],
  "hdr-color": ["production-HDR-authored-single-sun-flat-normal-triangles"],
  "post-bloom": ["actual-production-Bloom-textures-per-legal-profile"],
  "post-fog": ["actual-legal-Fog-profiles"],
  display: ["production-output-common-subset"],
  normal: ["actual Web normal attachment", "actual production HDR shadow visibility"],
  "shadow-visibility": ["actual production HDR shadow visibility"],
  "main-depth": ["production-geometry-depth-interior"],
};

const layerById = id => ({
  id,
  evidenceDir: `test-output/interrupted-0930/${id}`,
  scopePrefixes: SCOPES[id],
  gateId: REQUIRED_LAYER_GATES[id],
  fixtureFile: id === "post-bloom" ? "packages/deep-engine/fixtures/j3-bloom-texture-v1.json"
    : id === "post-fog" ? "packages/deep-engine/fixtures/j3-fog-profiles-v1.json" : undefined,
  freshnessKey: ["post-bloom", "post-fog"].includes(id) ? "fixtureHash" : undefined,
});

const goodEvidence = layer => ({
  passed: true, stable: true, currentRun: true,
  scope: `${layer.scopePrefixes[0]}-contract`,
  ...(layer.freshnessKey ? { [layer.freshnessKey]: hash("current-fixture-bytes") } : {}),
});
const identity = () => hash("current-fixture-bytes");

test("合法差异矩阵 v1:14 条、id 唯一、层引用全部合法", () => {
  assert.equal(LEGAL_DIFFERENCE_MATRIX_V1.length, 14);
  assert.equal(new Set(LEGAL_DIFFERENCE_MATRIX_V1.map(entry => entry.id)).size, 14);
  for (const entry of LEGAL_DIFFERENCE_MATRIX_V1)
    for (const layer of entry.layer) assert.ok(REQUIRED_LAYER_GATES[layer], `${entry.id} 引用未知层 ${layer}`);
});

test("错层证据必须 FAIL:hdr 层喂入 bloom scope 被拒", () => {
  const hdrLayer = layerById("hdr-color"), bloomLayer = layerById("post-bloom");
  assert.throws(() => validateLayerEvidence(hdrLayer, goodEvidence(bloomLayer)),
    /wrong-layer evidence: scope "actual-production-Bloom-textures-per-legal-profile[^\"]*" does not match layer hdr-color/);
});

test("错门必须 FAIL:目录绑定被篡改、evidence 声明门被篡改", () => {
  const bloomLayer = layerById("post-bloom");
  assert.throws(() => validateLayerEvidence({ ...bloomLayer, gateId: "display-byte" }, goodEvidence(bloomLayer)),
    /wrong-gate binding/);
  assert.throws(() => validateLayerEvidence(bloomLayer, { ...goodEvidence(bloomLayer), gateId: "hdr-flat-strict" }),
    /wrong-gate evidence.*contract requires "post-half-store"/);
});

test("证据过期必须 FAIL:fixtureHash 与现算源身份不一致", () => {
  const bloomLayer = layerById("post-bloom");
  const stale = { ...goodEvidence(bloomLayer), fixtureHash: hash("old-fixture-bytes") };
  assert.throws(() => validateLayerEvidence(bloomLayer, stale, { expectedIdentity: identity() }),
    /stale evidence: post-bloom recorded fixtureHash/);
  assert.throws(() => validateLayerEvidence(bloomLayer, { ...goodEvidence(bloomLayer), fixtureHash: "short" }),
    /lacks recorded fixtureHash identity/);
  // 同一身份 + fresh 要求满足时通过。
  assert.equal(validateLayerEvidence(bloomLayer, goodEvidence(bloomLayer),
    { expectedIdentity: identity(), freshRequired: true }), true);
});

test("失败/不稳定/历史冒充 fresh 必须FAIL", () => {
  const fogLayer = layerById("post-fog");
  assert.throws(() => validateLayerEvidence(fogLayer, { ...goodEvidence(fogLayer), passed: false }), /reports failure/);
  assert.throws(() => validateLayerEvidence(fogLayer, { ...goodEvidence(fogLayer), stable: false }), /reports instability/);
  const historical = { ...goodEvidence(fogLayer), currentRun: false };
  assert.throws(() => validateLayerEvidence(fogLayer, historical, { freshRequired: true }), /historical receipt presented as fresh/);
  assert.throws(() => validateLayerEvidence(fogLayer,
    { ...goodEvidence(fogLayer), execution: "historical file comparison; no host executed" }),
    /must not claim currentRun=true/);
});

test("无身份键的层照常校验,聚合时登记 freshness 说明", () => {
  const displayLayer = layerById("display");
  assert.equal(validateLayerEvidence(displayLayer, goodEvidence(displayLayer), { freshRequired: true }), true);
});

test("registerLegalDifference:缺字段/撞号/未知层/缺证据文件均拒绝,合法新条目可追加", () => {
  assert.throws(() => registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1, { id: "LD-15", layer: ["display"] }),
    /missing "(difference|host|rule|evidence|status)"/);
  assert.throws(() => registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1,
    { ...LEGALLD15(), id: "LD-01" }), /Duplicate legal difference id LD-01/);
  assert.throws(() => registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1,
    { ...LEGALLD15(), layer: ["not-a-layer"] }), /Unknown layer "not-a-layer"/);
  assert.throws(() => registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1,
    { ...LEGALLD15(), evidence: ["docs/specs/no-such-doc.md"] }), /cites missing evidence file/);
  const appended = registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1, LEGALLD15());
  assert.equal(appended.length, LEGAL_DIFFERENCE_MATRIX_V1.length + 1);
  assert.equal(appended.at(-1).id, "LD-15");
  function LEGALLD15() {
    return { id: "LD-15", layer: ["display"], difference: "示例:两端 tone mapper 数值边界", host: { web: "x", native: "y" },
      rule: "z", evidence: ["docs/specs/j3-gate-d-output-first-cut-20260930.md"], status: "diagnostic" };
  }
});

test("聚合器:8 层格网展开、--compare 语义 currentRun=false、缺证据即 FAIL", async () => {
  const layers = ["geometry-coverage", "main-depth", "normal", "shadow-visibility", "hdr-color",
    "post-bloom", "post-fog", "display"].map(layerById);
  const cellsOf = layer => [{ cellId: `${layer.id}-cell`, hostScope: "web+native" }];
  const store = Object.fromEntries(layers.map(layer => [layer.id, goodEvidence(layer)]));
  const aggregate = await aggregateLayerMatrix({ layers, loadEvidence: layer => store[layer.id],
    identityOf: layer => (layer.freshnessKey ? identity() : undefined), cellsOf, compare: true });
  assert.equal(aggregate.currentRun, false);
  assert.equal(aggregate.grid.length, layers.length);
  assert.equal(aggregate.legalDifferenceMatrix, LEGAL_DIFFERENCE_MATRIX_V1);
  assert.ok(aggregate.execution.includes("no host executed"));
  delete store["hdr-color"];
  assert.rejects(() => aggregateLayerMatrix({ layers, loadEvidence: layer => store[layer.id],
    identityOf: () => undefined, cellsOf, compare: true }), /Layer hdr-color evidence missing/);
});
