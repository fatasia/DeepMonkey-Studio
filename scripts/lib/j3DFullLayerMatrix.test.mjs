// J3-D-full 逐层矩阵聚合器负例/合同测试:错层、错门、证据过期、失败/不稳定、历史冒充 fresh、差异登记。
// 全部 CPU 合成数据,不依赖 test-output 现存文件与 GPU。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { REQUIRED_LAYER_GATES, LEGAL_DIFFERENCE_MATRIX_V1, registerLegalDifference,
  validateLayerEvidence, aggregateLayerMatrix } from "./j3DFullLayerMatrix.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

const SCOPES = {
  "texture-coverage": ["actual-production-texture-UV-MR-alpha-coverage"],
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
  sourceIdentity: { "packages/deep-engine/src/webgpu/pbrShader.ts": hash("current-production-bytes") },
  ...(layer.id === "normal" ? { normals: { passed: true, stable: true } } : {}),
  ...(layer.freshnessKey ? { [layer.freshnessKey]: hash("current-fixture-bytes") } : {}),
});
const identity = () => hash("current-fixture-bytes");
const currentSources = () => goodEvidence(layerById("display")).sourceIdentity;

test("合法差异矩阵:17 条(v1十四+LD-15 高光峰量化边界+root 裁定的 LD-16/LD-17)、id 唯一、层引用全部合法", () => {
  assert.equal(LEGAL_DIFFERENCE_MATRIX_V1.length, 17);
  assert.equal(new Set(LEGAL_DIFFERENCE_MATRIX_V1.map(entry => entry.id)).size, 17);
  for (const entry of LEGAL_DIFFERENCE_MATRIX_V1)
    for (const layer of entry.layer) assert.ok(REQUIRED_LAYER_GATES[layer], `${entry.id} 引用未知层 ${layer}`);
});

test("LD-15 修订与 LD-16/LD-17 登记:root 裁定落位、diagnostic 不豁免门、四判据可机读、证据文件全部存在", () => {
  const byId = Object.fromEntries(LEGAL_DIFFERENCE_MATRIX_V1.map(entry => [entry.id, entry]));
  // LD-15 修订:裸『邻域符号混合』必要条件废止,替换为全域混合+D 尖峰邻域增益解释,跨域引用以 LD-16 为准。
  assert.ok(byId["LD-15"].rule.includes("全域符号混合"), "LD-15 修订后 rule 必须含全域符号混合判据");
  assert.ok(byId["LD-15"].rule.includes("废止"), "LD-15 修订必须显式声明旧判据废止");
  assert.ok(byId["LD-15"].rule.includes("LD-16"), "LD-15 跨域引用必须指向 LD-16");
  assert.ok(!/3×3 邻域符号混合\)/.test(byId["LD-15"].rule), "LD-15 不得再把局部 3×3 符号混合当必要条件");
  assert.ok(byId["LD-15"].evidence.includes("docs/specs/c8-ld16-ld17-adjudication-20261002.md"));
  // LD-16/LD-17:diagnostic 仅归因,不豁免 .002 门;rule 含编号四判据。
  for (const id of ["LD-16", "LD-17"]) {
    const entry = byId[id];
    assert.equal(entry.status, "diagnostic");
    assert.ok(entry.rule.includes("不构成 .002 门豁免"), `${id} 必须声明不豁免门`);
    for (const marker of ["(1)", "(2)", "(3)", "(4)"]) assert.ok(entry.rule.includes(marker), `${id} rule 缺判据 ${marker}`);
    assert.ok(entry.evidence.includes("docs/specs/c8-ld16-ld17-adjudication-20261002.md"));
  }
  assert.ok(byId["LD-16"].rule.includes("系统性 >1.5 ULP F32 同号差不得援引"), "LD-16 效力边界缺失");
  assert.ok(byId["LD-17"].rule.includes("重新验证"), "LD-17 后端变化重验条款缺失");
  // 裁定引用的 test-output 证据实际存在(registerLegalDifference 只校验 docs/packages/scripts 前缀)。
  for (const entry of [byId["LD-16"], byId["LD-17"]])
    for (const item of entry.evidence) assert.ok(existsSync(item), `${entry.id} 证据文件缺失: ${item}`);
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
    { expectedIdentity: identity(), expectedSources: currentSources(), freshRequired: true }), true);
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
  assert.equal(validateLayerEvidence(displayLayer, goodEvidence(displayLayer),
    { expectedSources: currentSources(), freshRequired: true }), true);
});

test("法线层不能由不含实际 normals 的阴影通过收据代替", () => {
  const layer = layerById("normal"), evidence = goodEvidence(layer);
  delete evidence.normals;
  assert.throws(() => validateLayerEvidence(layer, evidence), /requires passed, stable normals/);
  for (const normals of [{ passed: false, stable: true }, { passed: true, stable: false }])
    assert.throws(() => validateLayerEvidence(layer, { ...evidence, normals }), /normals attachment evidence/);
});

test("同fixture与currentRun不能绕过生产源漂移、缺失源与空摘要", () => {
  const layer = layerById("post-bloom"), evidence = goodEvidence(layer);
  assert.throws(() => validateLayerEvidence(layer, evidence,
    { expectedSources: { "packages/deep-engine/src/webgpu/pbrShader.ts": hash("changed") }, freshRequired: true }),
    /stale production evidence/);
  assert.throws(() => validateLayerEvidence(layer, evidence, { expectedSources: {}, freshRequired: true }),
    /stale production evidence/);
  assert.throws(() => validateLayerEvidence(layer, { ...evidence, sourceIdentity: undefined },
    { expectedSources: currentSources(), freshRequired: true }), /lacks verified production source identity/);
  assert.throws(() => validateLayerEvidence(layer, { ...evidence, sourceIdentity: {} }),
    /invalid production source identity/);
  assert.throws(() => validateLayerEvidence(layer, { ...evidence,
    sourceIdentity: { ...currentSources(), "packages/../private.ts": hash("private") } }),
    /invalid production source identity/);
  assert.throws(() => validateLayerEvidence(layer, evidence, { freshRequired: true }),
    /lacks verified production source identity/);
  assert.equal(validateLayerEvidence(layer, { ...evidence, sourceIdentity: { sources: currentSources(), sha256: hash("digest") } },
    { expectedSources: currentSources(), freshRequired: true }), true);
  const withManifest = { ...currentSources(), "package.json": hash("manifest"), "pnpm-lock.yaml": hash("lock") };
  assert.equal(validateLayerEvidence(layer, { ...evidence, sourceIdentity: withManifest },
    { expectedSources: withManifest, freshRequired: true }), true);
});

test("聚合拒绝空或重复场景格,并且 fresh 聚合必须复核每层生产源", async () => {
  const layer = layerById("normal"), cells = [{ cellId: "front", hostScope: "web+native" }];
  const options = { layers: [layer], loadEvidence: () => goodEvidence(layer), sourcesOf: currentSources,
    cellsOf: () => cells, compare: false };
  const aggregate = await aggregateLayerMatrix(options);
  assert.equal(aggregate.currentRun, true);
  await assert.rejects(() => aggregateLayerMatrix({ ...options, cellsOf: () => [] }), /scene cells missing/);
  await assert.rejects(() => aggregateLayerMatrix({ ...options, cellsOf: () => [...cells, ...cells] }), /duplicated/);
  await assert.rejects(() => aggregateLayerMatrix({ ...options, sourcesOf: () => ({}) }), /stale production evidence/);
});

test("registerLegalDifference:缺字段/撞号/未知层/缺证据文件均拒绝,合法新条目可追加", () => {
  assert.throws(() => registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1, { id: "LD-18", layer: ["display"] }),
    /missing "(difference|host|rule|evidence|status)"/);
  assert.throws(() => registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1,
    { ...LD18Example(), id: "LD-01" }), /Duplicate legal difference id LD-01/);
  // 已登记的真实裁定条目(LD-16)再次追加同样被撞号门拒绝。
  assert.throws(() => registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1,
    LEGAL_DIFFERENCE_MATRIX_V1.find(entry => entry.id === "LD-16")), /Duplicate legal difference id LD-16/);
  assert.throws(() => registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1,
    { ...LD18Example(), layer: ["not-a-layer"] }), /Unknown layer "not-a-layer"/);
  assert.throws(() => registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1,
    { ...LD18Example(), evidence: ["docs/specs/no-such-doc.md"] }), /cites missing evidence file/);
  const appended = registerLegalDifference(LEGAL_DIFFERENCE_MATRIX_V1, LD18Example());
  assert.equal(appended.length, LEGAL_DIFFERENCE_MATRIX_V1.length + 1);
  assert.equal(appended.at(-1).id, "LD-18");
  assert.equal(appended.at(-2).id, "LD-17");
  function LD18Example() {
    return { id: "LD-18", layer: ["display"], difference: "示例:两端 tone mapper 数值边界", host: { web: "x", native: "y" },
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
